import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "./supabaseClient";

const COURT_LIMIT = 5;

const SPORTS = [
  { name: "籃球", icon: "🏀", target: 10, roles: ["PG", "SG", "SF", "PF", "C"] },
  { name: "排球", icon: "🏐", target: 12, roles: ["舉球", "攻擊", "攔中", "自由", "全能"] },
  { name: "羽球", icon: "🏸", target: 4, roles: ["前場", "後場", "全能"] },
];

const TIME_OPTIONS = Array.from({ length: 15 }, (_, index) => {
  const hour = index + 8;
  return `${String(hour).padStart(2, "0")}:00`;
});

function buildTimeSlot(startTime, endTime) {
  return `${startTime} - ${endTime}`;
}

function getHour(timeText) {
  return Number(timeText.slice(0, 2));
}

function getValidEndTimes(startTime) {
  return TIME_OPTIONS.filter((time) => getHour(time) >= getHour(startTime) + 1);
}

function createInviteCode() {
  const characters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let index = 0; index < 6; index += 1) {
    code += characters[Math.floor(Math.random() * characters.length)];
  }
  return code;
}

function getSport(name) {
  return SPORTS.find((sport) => sport.name === name) || SPORTS[0];
}

function statusLabel(status) {
  if (status === "full") return "已成局";
  if (status === "waiting") return "場地候補";
  return "揪團中";
}

function getRoleDifference(teamA, teamB) {
  const roles = new Set([...teamA.map((p) => p.role), ...teamB.map((p) => p.role)]);
  let difference = 0;

  roles.forEach((role) => {
    const a = teamA.filter((p) => p.role === role).length;
    const b = teamB.filter((p) => p.role === role).length;
    difference += Math.abs(a - b);
  });

  return difference;
}

function combinations(players, targetSize) {
  const results = [];

  function dfs(start, selected) {
    if (selected.length === targetSize) {
      results.push([...selected]);
      return;
    }

    for (let index = start; index < players.length; index += 1) {
      selected.push(players[index]);
      dfs(index + 1, selected);
      selected.pop();
    }
  }

  dfs(0, []);
  return results;
}

function balanceTeams(players) {
  if (!players.length || players.length % 2 !== 0) return null;

  let best = null;
  let bestDifference = Infinity;

  combinations(players, players.length / 2).forEach((teamA) => {
    const teamAIds = new Set(teamA.map((player) => player.id));
    const teamB = players.filter((player) => !teamAIds.has(player.id));
    const difference = getRoleDifference(teamA, teamB);

    if (difference < bestDifference) {
      bestDifference = difference;
      best = { teamA, teamB, difference };
    }
  });

  return best;
}

function arrangeCourts(rawEvents) {
  const events = rawEvents.map((event) => ({
    id: event.id,
    creatorId: event.creator_id,
    sport: event.sport,
    date: event.event_date,
    timeSlot: event.time_slot,
    maxPlayers: event.max_players,
    title: event.title,
    createdAt: event.created_at,
    isPrivate: event.is_private,
    members: event.event_members || [],
    status: "open",
    court: null,
  }));

  const groups = new Map();

  events.forEach((event) => {
    const key = `${event.date}|${event.timeSlot}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  });

  groups.forEach((group) => {
    group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    let courtNumber = 0;

    group.forEach((event) => {
      if (event.members.length >= event.maxPlayers) {
        courtNumber += 1;

        if (courtNumber <= COURT_LIMIT) {
          event.status = "full";
          event.court = courtNumber;
        } else {
          event.status = "waiting";
        }
      }
    });
  });

  return events.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function canCancelBeforeStart(event) {
  if (!event) return false;

  const startHour = Number(event.timeSlot.slice(0, 2));
  const startMinute = Number(event.timeSlot.slice(3, 5));
  const startTime = new Date(`${event.date}T${String(startHour).padStart(2, "0")}:${String(startMinute).padStart(2, "0")}:00`);
  const cancelDeadline = new Date(startTime.getTime() - 30 * 60 * 1000);

  return new Date() < cancelDeadline;
}

export default function App() {
  const [events, setEvents] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState("登入後即可建立活動、加入名單與完成本人簽到。 ");
  const [eventForm, setEventForm] = useState({
    title: "",
    sport: "籃球",
    date: new Date().toISOString().slice(0, 10),
    startTime: "18:00",
    endTime: "19:00",
    maxPlayers: 10,
    isPrivate: false,
  });
  const [memberForm, setMemberForm] = useState({ name: "", role: "PG" });
  const [joinInviteCode, setJoinInviteCode] = useState("");
  const [ownerInviteCode, setOwnerInviteCode] = useState(null);

  useEffect(() => {
    async function prepareAuth() {
      const { data } = await supabase.auth.getSession();
      setSession(data.session);
    }

    prepareAuth();

    const { data: authListener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
    });

    return () => authListener.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    loadEvents();
  }, []);

  async function loadEvents() {
    setLoading(true);

    // 先請 Supabase 清除已過期活動，避免介面顯示太多舊資料
    await supabase.rpc("cleanup_expired_events");

    const { data, error } = await supabase
      .from("events")
      .select(`
        id, creator_id, title, sport, event_date, time_slot, max_players, status, court, created_at, is_private,
        event_members (id, event_id, user_id, display_name, role, attendance_status, checked_in_at, joined_at)
      `)
      .order("created_at", { ascending: false });

    if (error) {
      setNotice(`活動讀取失敗：${error.message}`);
      setLoading(false);
      return;
    }

    const arrangedEvents = arrangeCourts(data || []);
    setEvents(arrangedEvents);
    setSelectedId((previous) => {
      if (previous && arrangedEvents.some((event) => event.id === previous)) return previous;
      return arrangedEvents[0]?.id || null;
    });
    setLoading(false);
  }

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedId) || null,
    [events, selectedId]
  );

  useEffect(() => {
    if (!selectedEvent) return;

    const roles = getSport(selectedEvent.sport).roles;
    setMemberForm((previous) => ({
      ...previous,
      role: roles.includes(previous.role) ? previous.role : roles[0],
    }));
    setJoinInviteCode("");
  }, [selectedEvent?.id, selectedEvent?.sport]);

  useEffect(() => {
    async function loadVisibleInviteCode() {
      setOwnerInviteCode(null);
      if (!selectedEvent) return;

      const { data, error } = await supabase.rpc("get_visible_event_invite_code", {
        p_event_id: selectedEvent.id,
      });

      if (!error && data) setOwnerInviteCode(data);
    }

    loadVisibleInviteCode();
  }, [session, selectedEvent?.id, selectedEvent?.creatorId, selectedEvent?.isPrivate]);

  const fullGames = events.filter((event) => event.status === "full").length;
  const activePlayers = events.reduce((total, event) => total + event.members.length, 0);
  const openEvents = events.filter((event) => event.status === "open").length;
  const myMembership = selectedEvent?.members.find((member) => member.user_id === session?.user?.id);
  const selectedTeams = selectedEvent?.status === "full" ? balanceTeams(selectedEvent.members) : null;

  function requireLogin() {
    if (session) return true;
    setNotice("請先使用 Google 帳號登入。 ");
    return false;
  }

  async function signInWithGoogle() {
    const { error } = await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: window.location.origin,
        queryParams: { prompt: "select_account" },
      },
    });

    if (error) setNotice(`登入失敗：${error.message}`);
  }

  async function signOut() {
    const { error } = await supabase.auth.signOut();

    if (error) {
      setNotice(`登出失敗：${error.message}`);
      return;
    }

    setNotice("你已登出，目前只能瀏覽活動。 ");
  }

  function updateSport(sportName) {
    const sport = getSport(sportName);
    setEventForm((previous) => ({ ...previous, sport: sportName, maxPlayers: sport.target }));
  }

  function updateStartTime(startTime) {
    const validEndTimes = getValidEndTimes(startTime);
    const currentEndTime = eventForm.endTime;
    const nextEndTime = validEndTimes.includes(currentEndTime) ? currentEndTime : validEndTimes[0];
    setEventForm((previous) => ({ ...previous, startTime, endTime: nextEndTime }));
  }

  function updateEndTime(endTime) {
    setEventForm((previous) => ({ ...previous, endTime }));
  }

  async function createEvent(e) {
    e.preventDefault();
    if (!requireLogin()) return;

    const inviteCode = createInviteCode();

    const { data, error } = await supabase
      .from("events")
      .insert({
        creator_id: session.user.id,
        title: eventForm.title.trim() || null,
        sport: eventForm.sport,
        event_date: eventForm.date,
        time_slot: buildTimeSlot(eventForm.startTime, eventForm.endTime),
        max_players: Number(eventForm.maxPlayers),
        is_private: eventForm.isPrivate,
        invite_code: inviteCode,
        status: "open",
      })
      .select("id")
      .single();

    if (error) {
      setNotice(`建立活動失敗：${error.message}`);
      return;
    }

    setOwnerInviteCode(inviteCode);

    if (eventForm.isPrivate) {
      setNotice(`私人活動建立成功！邀請碼：${inviteCode}，只有輸入邀請碼的人可以加入。`);
    } else {
      setNotice(`公開活動建立成功！邀請碼：${inviteCode}，可分享給球友；沒有邀請碼也能加入。`);
    }

    await loadEvents();
    setSelectedId(data.id);
  }

  async function joinSelectedEvent(e) {
    e.preventDefault();
    if (!requireLogin() || !selectedEvent) return;

    if (selectedEvent.status !== "open") {
      setNotice("此活動已無法再加入。 ");
      return;
    }

    if (!memberForm.name.trim()) {
      setNotice("請輸入你要顯示的名稱。 ");
      return;
    }

    if (selectedEvent.isPrivate && !joinInviteCode.trim()) {
      setNotice("這是私人活動，請輸入邀請碼後再加入。 ");
      return;
    }

    const { error } = await supabase.rpc("join_event_with_invite", {
      p_event_id: selectedEvent.id,
      p_display_name: memberForm.name.trim(),
      p_role: memberForm.role,
      p_invite_code: joinInviteCode.trim() ? joinInviteCode.trim().toUpperCase() : null,
    });

    if (error) {
      if (error.message.includes("duplicate") || error.code === "23505") {
        setNotice("你已加入這場活動，不能重複報名。 ");
      } else if (error.message.includes("邀請碼")) {
        setNotice("邀請碼錯誤，請確認後重新輸入。 ");
      } else {
        setNotice(`加入失敗：${error.message}`);
      }
      return;
    }

    setMemberForm((previous) => ({ ...previous, name: "" }));
    setJoinInviteCode("");
    setNotice("加入成功！你的報名資料已存入後台。 ");
    await loadEvents();
  }

  async function cancelMyRegistration() {
    if (!requireLogin() || !selectedEvent) return;

    if (!myMembership) {
      setNotice("你沒有加入這場活動，無法取消報名。 ");
      return;
    }

    const { error } = await supabase.rpc("cancel_event_registration", {
      p_event_id: selectedEvent.id,
    });

    if (error) {
      if (error.message.includes("30")) {
        setNotice("活動開始前 30 分鐘內不可取消報名。 ");
      } else {
        setNotice(`取消失敗：${error.message}`);
      }
      return;
    }

    setNotice("已取消報名。 ");
    await loadEvents();
  }

  async function checkIn() {
    if (!requireLogin() || !selectedEvent) return;

    if (selectedEvent.status !== "full") {
      setNotice("活動成局後，才會開放簽到。 ");
      return;
    }

    if (!myMembership) {
      setNotice("你沒有加入這場活動，因此無法簽到。 ");
      return;
    }

    if (myMembership.attendance_status === "checked_in") {
      setNotice("你已經簽到完成。 ");
      return;
    }

    const { data, error } = await supabase
      .from("event_members")
      .update({
        attendance_status: "checked_in",
        checked_in_at: new Date().toISOString(),
      })
      .eq("event_id", selectedEvent.id)
      .eq("user_id", session.user.id)
      .select("id");

    if (error) {
      setNotice(`簽到失敗：${error.message}`);
      return;
    }

    if (!data?.length) {
      setNotice("簽到失敗：找不到你的參加紀錄。 ");
      return;
    }

    setNotice("簽到成功！後台已記錄你的到場狀態。 ");
    await loadEvents();
  }

  async function deleteEvent() {
    if (!requireLogin() || !selectedEvent) return;

    if (selectedEvent.creatorId !== session.user.id) {
      setNotice("只有活動建立者可以刪除活動。 ");
      return;
    }

    const { error } = await supabase.from("events").delete().eq("id", selectedEvent.id);

    if (error) {
      setNotice(`刪除失敗：${error.message}`);
      return;
    }

    setNotice("活動已刪除。 ");
    await loadEvents();
  }

  return (
    <>
      <style>{styles}</style>
      <div className="app">
        <nav className="nav">
          <div className="brand"><span>●</span> SportMate</div>
          {session ? (
            <div className="account">
              <span>您好，{session.user.user_metadata?.full_name || session.user.email}</span>
              <button onClick={signOut}>登出</button>
            </div>
          ) : (
            <button className="google" onClick={signInWithGoogle}>G　使用 Google 登入</button>
          )}
        </nav>

        <header className="hero">
          <div>
            <p className="eyebrow">SPORTS MATCHMAKING SYSTEM</p>
            <h1>找球友，<br /><b>輕鬆成局。</b></h1>
            <p>選擇運動與時間，系統協助集合球員、安排場地並完成分隊。</p>
          </div>
          <div className="balls"><span>🏀</span><span>🏸</span><span>🏐</span></div>
        </header>

        <section className="stats">
          <Stat value={events.length} label="目前活動" />
          <Stat value={activePlayers} label="參加球員" />
          <Stat value={openEvents} label="揪團中" />
          <Stat value={fullGames} label="已成局" />
        </section>

        <div className="notice">💡 {notice}</div>

        <main className="grid">
          <section className="panel">
            <h2>建立活動</h2>
            {!session && <div className="hint">登入後即可建立活動</div>}
            <form className="form" onSubmit={createEvent}>
              <Field label="活動名稱（可不填）">
                <input
                  placeholder="例如：週五晚間輕鬆場"
                  value={eventForm.title}
                  onChange={(e) => setEventForm({ ...eventForm, title: e.target.value })}
                />
              </Field>

              <Field label="運動種類">
                <select value={eventForm.sport} onChange={(e) => updateSport(e.target.value)}>
                  {SPORTS.map((sport) => <option key={sport.name} value={sport.name}>{sport.icon} {sport.name}</option>)}
                </select>
              </Field>

              <Field label="日期">
                <input type="date" value={eventForm.date} onChange={(e) => setEventForm({ ...eventForm, date: e.target.value })} />
              </Field>

              <div className="time-row">
                <Field label="開始時間">
                  <select value={eventForm.startTime} onChange={(e) => updateStartTime(e.target.value)}>
                    {TIME_OPTIONS.slice(0, -1).map((time) => <option key={time}>{time}</option>)}
                  </select>
                </Field>

                <Field label="結束時間">
                  <select value={eventForm.endTime} onChange={(e) => updateEndTime(e.target.value)}>
                    {getValidEndTimes(eventForm.startTime).map((time) => <option key={time}>{time}</option>)}
                  </select>
                </Field>
              </div>
              <p className="time-help">活動時間至少 1 小時，可自由選擇更長時段。</p>

              <Field label="滿場人數">
                <input type="number" min="2" max="20" step="2" value={eventForm.maxPlayers} onChange={(e) => setEventForm({ ...eventForm, maxPlayers: e.target.value })} />
              </Field>

              <label className="privacy-choice">
                <input
                  type="checkbox"
                  checked={eventForm.isPrivate}
                  onChange={(e) => setEventForm({ ...eventForm, isPrivate: e.target.checked })}
                />
                <div>
                  <strong>私人活動</strong>
                  <small>勾選後，只有持有邀請碼的人可以加入；未勾選則公開加入</small>
                </div>
              </label>

              <button className="primary">建立活動</button>
            </form>
          </section>

          <section className="panel events">
            <div className="section-head"><h2>可加入的活動</h2><button onClick={loadEvents}>重新整理</button></div>
            {loading ? <div className="empty">讀取活動中...</div> : events.length === 0 ? <div className="empty">目前沒有活動，請建立第一場活動。</div> : (
              <div className="cards">
                {events.map((event) => {
                  const sport = getSport(event.sport);
                  const percentage = Math.min((event.members.length / event.maxPlayers) * 100, 100);
                  return (
                    <button key={event.id} className={`card ${selectedId === event.id ? "selected" : ""}`} onClick={() => setSelectedId(event.id)}>
                      <div className="card-head">
                        <strong>{sport.icon} {event.title || `${event.sport}活動`}</strong>
                        <div className="card-badges">
                          {event.isPrivate && <i className="private">🔒 私人</i>}
                          <i className={event.status}>{statusLabel(event.status)}</i>
                        </div>
                      </div>
                      <p>{event.sport}　{event.date}　{event.timeSlot}</p>
                      <div className="bar"><span style={{ width: `${percentage}%` }} /></div>
                      <div className="card-footer"><span>{event.members.length} / {event.maxPlayers} 人</span><b>{event.court ? `${event.court} 號場` : `還差 ${Math.max(event.maxPlayers - event.members.length, 0)} 人`}</b></div>
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        </main>

        {selectedEvent && (
          <section className="panel detail">
            <div className="detail-head">
              <div>
                <p className="eyebrow">SELECTED EVENT</p>
                <h2>{getSport(selectedEvent.sport).icon} {selectedEvent.title || `${selectedEvent.sport}活動`} {selectedEvent.isPrivate && <small className="private-title">🔒 私人</small>}</h2>
                <span>{selectedEvent.sport}　｜　{selectedEvent.date}　{selectedEvent.timeSlot}{selectedEvent.court && `　｜　${selectedEvent.court} 號場`}</span>
                {ownerInviteCode && (
                  <div className="invite-display">
                    邀請碼：<b>{ownerInviteCode}</b><small>{selectedEvent.isPrivate ? "私人活動必須輸入此代碼" : "公開活動可分享，未輸入也能加入"}</small>
                  </div>
                )}
              </div>
              {session?.user?.id === selectedEvent.creatorId && <button className="danger" onClick={deleteEvent}>刪除活動</button>}
            </div>

            {selectedEvent.status === "open" && (
              <form className="join" onSubmit={joinSelectedEvent}>
                <strong>加入活動</strong>
                <Field label="顯示名稱"><input placeholder="請輸入名稱" value={memberForm.name} onChange={(e) => setMemberForm({ ...memberForm, name: e.target.value })} /></Field>
                <Field label="位置 / 角色"><select value={memberForm.role} onChange={(e) => setMemberForm({ ...memberForm, role: e.target.value })}>{getSport(selectedEvent.sport).roles.map((role) => <option key={role}>{role}</option>)}</select></Field>
                <Field label={selectedEvent.isPrivate ? "邀請碼（必填）" : "邀請碼（選填）"}><input maxLength="6" placeholder={selectedEvent.isPrivate ? "輸入 6 碼" : "公開活動可不填"} value={joinInviteCode} onChange={(e) => setJoinInviteCode(e.target.value.toUpperCase())} /></Field>
                <button className="primary">加入名單</button>
              </form>
            )}

            {myMembership && (
              <div className="cancel-box">
                <div>
                  <strong>你已加入此活動</strong>
                  <small>{canCancelBeforeStart(selectedEvent) ? "活動開始前 30 分鐘以前可以取消報名" : "已超過可取消時間"}</small>
                </div>
                <button className="cancel-button" onClick={cancelMyRegistration} disabled={!canCancelBeforeStart(selectedEvent)}>取消報名</button>
              </div>
            )}

            <div className="members">
              <h3>參加名單 <small>{selectedEvent.members.length} / {selectedEvent.maxPlayers}</small></h3>
              <div className="member-list">
                {selectedEvent.members.map((member) => (
                  <div className="member" key={member.id}>
                    <span className="avatar">{member.display_name.slice(0, 1)}</span>
                    <div><strong>{member.display_name}</strong><small>{member.role}</small></div>
                    {member.attendance_status === "checked_in" && <em>✓ 已到場</em>}
                  </div>
                ))}
              </div>
            </div>

            {selectedEvent.status === "full" && (
              <div className="attendance">
                <div className="section-head"><h3>到場簽到</h3><span>{selectedEvent.members.filter((m) => m.attendance_status === "checked_in").length} / {selectedEvent.members.length} 人已到場</span></div>
                {!session ? <div className="empty">請先登入後進行本人簽到。</div> : !myMembership ? <div className="empty">你未加入本活動，無法進行簽到。</div> : myMembership.attendance_status === "checked_in" ? <div className="success">✓ 你已完成簽到</div> : <button className="checkin" onClick={checkIn}>我要簽到</button>}
              </div>
            )}

            {selectedTeams && (
              <div className="match">
                <h3>分隊結果</h3><p>已依照位置分布進行平衡分隊</p>
                <div className="versus"><Team name="A 隊" players={selectedTeams.teamA} /><b className="vs">VS</b><Team name="B 隊" players={selectedTeams.teamB} /></div>
              </div>
            )}
          </section>
        )}
      </div>
    </>
  );
}

function Field({ label, children }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

function Stat({ value, label }) {
  return <div className="stat"><b>{value}</b><span>{label}</span></div>;
}

function Team({ name, players }) {
  return <div className="team"><h4>{name}</h4>{players.map((player) => <div key={player.id}><span>{player.display_name}</span><small>{player.role}</small></div>)}</div>;
}

const styles = `
*{box-sizing:border-box} body{margin:0;font-family:Inter,"Noto Sans TC","Microsoft JhengHei",Arial,sans-serif;background:#f6f8fc;color:#11233e} button,input,select{font:inherit} button{cursor:pointer;border:0}.app{max-width:1160px;margin:auto;padding:0 25px 40px}.nav{height:70px;display:flex;justify-content:space-between;align-items:center}.brand{font-size:23px;font-weight:800}.brand span{color:#2563eb;margin-right:8px}.google{height:44px;background:#fff;border:1px solid #dce5f2;padding:0 18px;border-radius:12px;font-weight:700;color:#23354d}.account{display:flex;align-items:center;gap:14px;color:#64748b;font-weight:600;font-size:14px}.account button{background:#eaf2ff;color:#2563eb;padding:11px 16px;border-radius:11px;font-weight:700}.hero{height:285px;background:#fff;border:1px solid #e8eef6;border-radius:28px;padding:42px 55px;display:flex;justify-content:space-between;align-items:center}.eyebrow{font-size:12px;color:#2563eb;font-weight:800;letter-spacing:.14em;margin:0 0 12px}.hero h1{font-size:48px;line-height:1.12;letter-spacing:-.07em;margin:0 0 12px}.hero h1 b{color:#2563eb}.hero p:not(.eyebrow){color:#64748b;line-height:1.8}.balls{width:310px;display:flex;align-items:center;justify-content:space-evenly;background:#edf4ff;border-radius:70px;height:160px}.balls span{font-size:52px;background:#fff;padding:18px;border-radius:27px;box-shadow:0 10px 25px #0f2f5b18}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin:18px 0}.stat{background:#fff;border:1px solid #e8eef6;border-radius:18px;padding:18px 23px;display:flex;align-items:center;gap:13px}.stat b{color:#2563eb;font-size:30px}.stat span{color:#64748b;font-weight:600}.notice{background:#eaf3ff;color:#31567e;padding:14px 17px;border-radius:14px;margin-bottom:18px}.grid{display:grid;grid-template-columns:340px 1fr;gap:18px}.panel{background:#fff;border:1px solid #e8eef6;border-radius:22px;padding:24px}.panel h2{margin:0 0 18px;font-size:21px}.hint{background:#fff6e3;color:#996500;font-size:13px;font-weight:600;padding:11px;border-radius:10px;margin-bottom:15px}.form{display:flex;flex-direction:column;gap:15px}.time-row{display:grid;grid-template-columns:1fr 1fr;gap:12px}.time-help{margin:-6px 0 0;color:#64748b;font-size:12px;line-height:1.5}.privacy-choice{display:flex;align-items:center;gap:11px;border:1px solid #e7edf5;border-radius:12px;padding:12px;background:#fbfcff}.privacy-choice input{width:18px;height:18px;accent-color:#2563eb}.privacy-choice strong{display:block;font-size:14px}.privacy-choice small{display:block;color:#64748b;font-size:12px;margin-top:3px}.field span{display:block;font-size:13px;font-weight:700;color:#64748b;margin-bottom:6px}.field input,.field select{width:100%;height:45px;border:1px solid #dce5f2;border-radius:11px;background:#fbfcff;padding:0 12px;outline:none}.field input:focus,.field select:focus{border-color:#2563eb}.primary{background:#2563eb;color:#fff;border-radius:12px;height:46px;font-weight:700}.section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:18px}.section-head h2,.section-head h3{margin:0}.section-head button{color:#2563eb;background:transparent;font-weight:700}.section-head span{background:#def7ea;color:#087443;padding:6px 12px;border-radius:50px;font-size:13px;font-weight:700}.cards{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}.card{text-align:left;background:#fff;border:1px solid #e7edf5;border-radius:16px;padding:17px}.card.selected,.card:hover{border-color:#83afff;background:#f7faff}.card-head,.card-footer{display:flex;justify-content:space-between;align-items:center}.card-badges{display:flex;align-items:center;gap:5px}.card-head strong{font-size:17px}.card-head i{font-style:normal;font-size:12px;font-weight:700;padding:5px 10px;border-radius:50px}.card-head i.open{color:#2563eb;background:#e8f1ff}.card-head i.full{color:#087443;background:#dff8ed}.card-head i.waiting{color:#b45309;background:#ffefd4}.card-head i.private{color:#6d28d9;background:#f1eafe}.card p{color:#64748b;font-size:13px}.bar{height:7px;background:#edf2f8;border-radius:20px;overflow:hidden;margin:13px 0}.bar span{height:100%;display:block;background:#2563eb}.card-footer{font-size:13px;color:#64748b}.card-footer b{color:#087443}.empty{background:#f8fafc;color:#64748b;padding:18px;border-radius:12px;text-align:center}.detail{margin-top:18px}.detail-head{display:flex;justify-content:space-between;align-items:start;margin-bottom:22px}.detail-head h2{font-size:25px;margin:0 0 7px}.private-title{font-size:13px;vertical-align:middle;background:#f1eafe;color:#6d28d9;padding:5px 9px;border-radius:50px}.detail-head span{color:#64748b}.invite-display{margin-top:13px;padding:11px 14px;background:#f5f0ff;color:#5b21b6;border-radius:12px;display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600}.invite-display b{font-size:18px;letter-spacing:.14em}.invite-display small{font-weight:500;color:#7c3aed}.danger{background:#fff1f2;color:#e11d48;padding:12px 16px;border-radius:11px;font-weight:700}.join{background:#f7f9fc;padding:18px;border-radius:16px;display:grid;grid-template-columns:115px repeat(3,minmax(130px,1fr)) 125px;gap:13px;align-items:end}.join>strong{align-self:center}.cancel-box{margin-top:18px;background:#fff7ed;border:1px solid #fed7aa;border-radius:15px;padding:15px;display:flex;justify-content:space-between;align-items:center;gap:15px}.cancel-box strong{display:block;color:#9a3412}.cancel-box small{display:block;color:#c2410c;margin-top:4px}.cancel-button{background:#f97316;color:#fff;border-radius:11px;height:42px;padding:0 16px;font-weight:800}.cancel-button:disabled{background:#d6d3d1;cursor:not-allowed}.members{margin-top:26px}.members h3{font-size:17px}.members h3 small{font-size:14px;color:#64748b;margin-left:8px}.member-list{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.member{border:1px solid #e8eef6;border-radius:13px;padding:10px;display:flex;gap:10px;align-items:center}.avatar{width:37px;height:37px;border-radius:50%;display:grid;place-items:center;background:#eaf2ff;color:#2563eb;font-weight:800}.member div strong{display:block;font-size:14px}.member div small{color:#64748b}.member em{font-style:normal;color:#087443;font-size:12px;font-weight:700;margin-left:auto}.attendance,.match{margin-top:26px;border-top:1px solid #e8eef6;padding-top:25px}.checkin{display:block;width:210px;height:47px;margin:10px auto 0;background:#10b981;color:#fff;border-radius:12px;font-weight:800}.success{background:#dff8ed;color:#087443;border-radius:12px;padding:16px;text-align:center;font-weight:700}.match{text-align:center}.match>h3{margin:0 0 5px}.match>p{color:#64748b;margin:0 0 18px}.versus{display:grid;grid-template-columns:1fr 62px 1fr;gap:13px;align-items:center}.vs{background:#10233f;color:#fff;border-radius:50%;height:52px;width:52px;display:grid;place-items:center;margin:auto}.team{border:1px solid #e8eef6;border-radius:16px;padding:16px;text-align:left}.team h4{text-align:center;color:#2563eb;margin:0 0 10px}.team div{display:flex;justify-content:space-between;background:#f7f9fc;padding:10px;border-radius:9px;margin-top:7px}.team small{color:#64748b}@media(max-width:900px){.app{padding:0 14px 30px}.hero{height:auto;padding:30px 24px}.hero h1{font-size:38px}.balls{display:none}.stats,.grid,.cards,.member-list,.versus{grid-template-columns:1fr}.join{grid-template-columns:1fr}.account span{display:none}}
`;
