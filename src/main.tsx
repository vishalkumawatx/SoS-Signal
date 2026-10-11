import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Alert, api, ApiError, Contact, User } from './api';
import './styles.css';

type IconName = 'shield' | 'home' | 'people' | 'clock' | 'arrow' | 'pin' | 'check' | 'close' | 'plus' | 'phone' | 'logout' | 'info';
function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, React.ReactNode> = {
    shield: <><path d="M12 3 4.5 6v5c0 4.5 3 7.8 7.5 10 4.5-2.2 7.5-5.5 7.5-10V6Z"/><path d="m8.5 12 2.3 2.3 4.7-4.8"/></>,
    home: <><path d="m3 10 9-7 9 7M5 9v11h14V9"/><path d="M9 20v-7h6v7"/></>,
    people: <><circle cx="9" cy="7" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 4a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 4v3"/></>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
    pin: <><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    close: <path d="m6 6 12 12M18 6 6 18"/>,
    plus: <path d="M12 5v14M5 12h14"/>,
    phone: <path d="m7 3 3 5-3 3a15 15 0 0 0 6 6l3-3 5 3-2 4C10 22 2 14 3 5Z"/>,
    logout: <><path d="M10 4H4v16h6M10 12h11m-4-4 4 4-4 4"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7v1"/></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Modal({ title, onClose, children, locked = false }: { title: string; onClose: () => void; children: React.ReactNode; locked?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const returnFocus = useRef(document.activeElement as HTMLElement | null);
  useEffect(() => {
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); returnFocus.current?.focus(); };
  }, []);
  return <dialog ref={ref} onCancel={e => { e.preventDefault(); if (!locked) onClose(); }} aria-labelledby="dialog-title">
    <div className="dialog-heading"><h2 id="dialog-title">{title}</h2><button className="icon-button" onClick={onClose} disabled={locked} aria-label="Close dialog"><Icon name="close"/></button></div>
    {children}
  </dialog>;
}

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [page, setPage] = useState('overview');
  const [modal, setModal] = useState<'auth' | 'contact' | 'sos' | 'help' | null>(null);
  const [register, setRegister] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [formError, setFormError] = useState('');
  const [formNotice, setFormNotice] = useState('');
  const [notice, setNotice] = useState('');
  const [location, setLocation] = useState<{ latitude: number; longitude: number; timestamp: number; accuracy: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState('');
  const [verifyContact, setVerifyContact] = useState<Contact | null>(null);
  const [removeContact, setRemoveContact] = useState<Contact | null>(null);
  const [includeLocation, setIncludeLocation] = useState(true);
  const [message, setMessage] = useState('I need help. Please call me or check on me as soon as possible.');
  const verified = contacts.filter(c => c.verified);
  const ready = !!user && configured && verified.length > 0;
  const errText = (e: unknown) => e instanceof Error ? e.message : 'Something went wrong. Please try again.';

  async function refresh() {
    const session = await api<{ user: User | null; configured: boolean }>('/session');
    setUser(session.user); setConfigured(session.configured);
    if (session.user) {
      const [c, a] = await Promise.all([api<{ contacts: Contact[] }>('/contacts'), api<{ alerts: Alert[] }>('/alerts')]);
      setContacts(c.contacts); setAlerts(a.alerts);
    } else { setContacts([]); setAlerts([]); }
    setLoaded(true);
  }
  useEffect(() => { refresh().catch(e => { setError(errText(e)); setLoaded(true); }); }, []);
  function open(value: typeof modal) { setFormError(''); setFormNotice(''); setModal(value); }
  function navigate(value: string) { setPage(value); setNotice(''); }
  async function run(action: () => Promise<void>, isForm = true) {
    setBusy(true); setFormNotice(''); if (isForm) setFormError(''); else setError('');
    try { await action(); } catch (e) {
      if (e instanceof ApiError && e.contact) {
        const pending = e.contact;
        setContacts(current => [...current.filter(c => c.id !== pending.id), pending]);
        setModal(null);
        setVerifyContact(pending);
      }
      if (isForm) setFormError(errText(e)); else setError(errText(e));
    }
    finally { setBusy(false); }
  }
  function locate() {
    setLocationError('');
    if (!navigator.geolocation) { setLocationError('Location is not supported by this browser. You can still send an SOS without it.'); return; }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(pos => {
      setLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude, timestamp: pos.timestamp, accuracy: pos.coords.accuracy }); setLocating(false);
    }, e => { setLocationError(e.code === 1 ? 'Location permission was denied. Enable it in browser settings, or send without a location.' : 'Could not get your location. Try again or send without it.'); setLocating(false); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
  }
  const formErrorView = <>{formError && <div className="form-error" role="alert">{formError}</div>}{formNotice && <div className="banner success" role="status">{formNotice}</div>}</>;

  function contactsView() {
    return <section className="contacts-section" aria-labelledby="contacts-title">
      <div className="section-heading"><div><span className="eyebrow">YOUR SUPPORT NETWORK</span><h2 id="contacts-title">Trusted contacts <span className="count">{contacts.length}/5</span></h2></div><button className="text-button" disabled={busy || contacts.length >= 5} onClick={() => open(user ? 'contact' : 'auth')}><Icon name="plus" size={17}/> Add contact</button></div>
      {contacts.length ? <div className="contact-list">{contacts.map(c => <div className="contact-row" key={c.id}><span className="avatar">{c.name.trim().slice(0, 1).toUpperCase()}</span><div className="contact-name"><strong>{c.name}</strong><span>{c.phone}</span></div><span className={`status ${c.verified ? 'green' : 'amber'}`}>{c.verified ? 'Verified' : 'Unverified'}</span><div className="contact-actions">{!c.verified && <button className="text-button" disabled={busy} onClick={() => { setVerifyContact(c); setFormError(''); setFormNotice(''); }}>Verify</button>}<button className="icon-button" disabled={busy} aria-label={`Remove ${c.name}`} onClick={() => { setRemoveContact(c); setFormError(''); }}><Icon name="close" size={17}/></button></div></div>)}</div> : <div className="empty-contacts"><div className="empty-symbol"><Icon name="people" size={27}/></div><div><h3>Start with someone you trust.</h3><p>Add up to five people who can respond when you need them. Only verified contacts receive alerts.</p><button className="text-button" onClick={() => open(user ? 'contact' : 'auth')}>Add your first contact <Icon name="arrow" size={16}/></button></div></div>}
      <p className="caption"><Icon name="info" size={14}/> Ask permission before adding someone. They’ll receive a verification code by SMS.</p>
    </section>;
  }
  function historyView() {
    return <section className="history-section" aria-labelledby="history-title"><div className="section-heading"><div><span className="eyebrow">A CLEAR RECORD</span><h2 id="history-title">Alert history</h2></div><button className="text-button" disabled={busy || !user} onClick={() => run(async () => { const data = await api<{ alerts: Alert[] }>('/alerts'); setAlerts(data.alerts); setNotice('Alert statuses refreshed.'); }, false)}>Refresh <Icon name="clock" size={16}/></button></div>
      {!alerts.length ? <div className="empty-history"><Icon name="clock" size={22}/><div><h3>No alerts to show</h3><p>Your sent alerts and each recipient’s delivery status will appear here.</p></div></div> : <div className="alert-list">{alerts.map(a => <article className="alert-row" key={a.id}><div className="alert-date"><Icon name="shield" size={18}/><strong>SOS alert</strong><time dateTime={a.createdAt}>{new Date(a.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time></div><p>{a.message}</p><div className="recipient-list">{a.recipients.map((r, i) => <div key={i}><span>{r.name}</span><span className={`status ${r.status === 'delivered' ? 'green' : ['failed', 'undelivered'].includes(r.status) ? 'red' : 'amber'}`}>{r.status}</span>{r.error && <small>{r.error}</small>}</div>)}</div>{a.latitude !== null && a.longitude !== null && <a className="text-button" href={`https://www.google.com/maps?q=${a.latitude},${a.longitude}`} target="_blank" rel="noreferrer">View shared location <Icon name="arrow" size={14}/></a>}</article>)}</div>}
      <p className="caption">Accepted or sent does not mean delivered. Delivery does not confirm that someone has read your alert.</p>
    </section>;
  }

  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#overview" onClick={() => navigate('overview')} aria-label="Signal home"><span className="brand-mark"><Icon name="shield" size={23}/></span>signal<span className="brand-period">.</span></a><div className="workspace-label">PERSONAL SAFETY</div><nav aria-label="Main navigation">{([{ id: 'overview', label: 'Overview', icon: 'home' }, { id: 'contacts', label: 'Trusted contacts', icon: 'people' }, { id: 'history', label: 'Alert history', icon: 'clock' }] as const).map(item => <button key={item.id} onClick={() => navigate(item.id)} className={`nav-item ${page === item.id ? 'active' : ''}`} aria-current={page === item.id ? 'page' : undefined}><Icon name={item.icon}/>{item.label}{item.id === 'contacts' && <span className="nav-count">{contacts.length}</span>}</button>)}</nav>
      <div className="sidebar-bottom"><div className="emergency-note"><Icon name="phone" size={19}/><strong>Immediate danger?</strong><p>Call your local emergency number first. Signal does not contact emergency services.</p><button className="text-button" onClick={() => open('help')}>Emergency guidance <Icon name="arrow" size={15}/></button></div><div className="sidebar-footer"><span className="small-mark">S.</span><span>For the people who matter.</span></div></div></aside>
    <div className="main-shell"><header className="topbar"><div className="breadcrumb">My safety <span>/</span> <strong>{page === 'overview' ? 'Overview' : page === 'contacts' ? 'Trusted contacts' : 'Alert history'}</strong></div>{user ? <div className="account"><span className="avatar small">{user.name.slice(0, 1).toUpperCase()}</span><span>{user.name}</span><button className="icon-button" title="Sign out" aria-label="Sign out" disabled={busy} onClick={() => run(async () => { await api('/auth/logout', {}); setUser(null); setContacts([]); setAlerts([]); setLocation(null); setNotice('Signed out.'); }, false)}><Icon name="logout" size={18}/></button></div> : <button className="text-button" onClick={() => open('auth')} disabled={!loaded}>Sign in <Icon name="arrow" size={17}/></button>}</header>
      <main id="main-content"><div className="page-title"><div><span className="eyebrow">A LITTLE PREPARATION. A CLOSER CONNECTION.</span><h1>{page === 'overview' ? 'Your safety, connected.' : page === 'contacts' ? 'Your people. Within reach.' : 'Every alert, accounted for.'}</h1><p>{page === 'overview' ? 'Keep your trusted people close. Reach them when it matters.' : page === 'contacts' ? 'Choose the people you want to turn to when you need help.' : 'Review what was sent and track SMS delivery to your contacts.'}</p></div><span className={`readiness-label ${ready ? 'is-ready' : ''}`}><span/>{ready ? 'Ready to alert' : 'Setup needed'}</span></div>
      {error && <div className="banner error" role="alert">{error}<button className="text-button" disabled={busy} onClick={() => run(refresh, false)}>Retry</button></div>}{notice && <div className="banner success" role="status">{notice}<button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice('')}><Icon name="close" size={16}/></button></div>}
      {!loaded ? <p className="loading" role="status">Loading your safety workspace…</p> : <>
      {page === 'overview' && <><div className="primary-grid"><section className="sos-panel" aria-labelledby="sos-title"><div className="panel-topline"><span className="eyebrow">WHEN YOU NEED A HAND</span><Icon name="shield" size={21}/></div><h2 id="sos-title">You don’t have to<br/>handle it alone.</h2><p>Send an SOS message to your trusted contacts, with your location if you choose.</p><button className="sos-button" disabled={busy} onClick={() => { setIncludeLocation(true); open(user ? 'sos' : 'auth'); }}><Icon name="shield" size={31}/><strong>SOS</strong><span>Send an alert</span></button><div className="sos-reassurance"><Icon name="check" size={15}/><span>You’ll review and confirm before anything is sent.</span></div><div className="sos-bottom"><span>SMS to verified contacts</span><span>No automatic dispatch</span></div></section>
      <div className="preparedness"><section className="readiness-section"><div className="section-heading compact"><h2>Before you need it</h2><span className="step-total">{Number(!!user) + Number(verified.length > 0) + Number(configured)}/3</span></div><p className="muted">A few essentials for your safety network.</p><ol className="setup-list"><li><span className={`step ${user ? 'complete' : ''}`}>{user ? <Icon name="check" size={15}/> : '1'}</span><div><strong>{user ? 'Your account is ready' : 'Make it personal'}</strong><p>{user ? 'Signed in securely.' : 'Create an account to save your contacts.'}</p></div>{!user && <button className="icon-button" aria-label="Create an account" onClick={() => { setRegister(true); open('auth'); }}><Icon name="arrow" size={18}/></button>}</li><li><span className={`step ${verified.length ? 'complete' : ''}`}>{verified.length ? <Icon name="check" size={15}/> : '2'}</span><div><strong>{verified.length ? `${verified.length} contact${verified.length === 1 ? '' : 's'} verified` : 'Add your trusted people'}</strong><p>{verified.length ? 'They can receive your SOS messages.' : 'Add a contact and verify their number.'}</p></div><button className="icon-button" aria-label="Manage trusted contacts" onClick={() => navigate('contacts')}><Icon name="arrow" size={18}/></button></li><li><span className={`step ${configured ? 'complete' : ''}`}>{configured ? <Icon name="check" size={15}/> : '3'}</span><div><strong>{configured ? 'SMS service configured' : 'Connect SMS delivery'}</strong><p>{configured ? 'Carrier delivery is not guaranteed.' : 'The server needs Twilio credentials.'}</p></div>{!configured && <button className="icon-button" aria-label="SMS setup information" onClick={() => open('help')}><Icon name="info" size={18}/></button>}</li></ol></section>
      <section className="location-section"><div className="location-heading"><span className="location-icon"><Icon name="pin" size={21}/></span><h2>Your location</h2><span className={`status ${location ? 'green' : ''}`}>{location ? 'Available' : 'Not shared'}</span></div><p>{location ? `Located at ${new Date(location.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. Accuracy approximately ${Math.round(location.accuracy)} m. Refresh if you’ve moved.` : 'Give your contacts a place to start. Your location is only shared when you send an alert.'}</p>{location && <div className="coordinates">{location.latitude.toFixed(5)}, {location.longitude.toFixed(5)}</div>}<button className="location-button" onClick={locate} disabled={locating}><Icon name="pin" size={16}/>{locating ? 'Finding your location…' : location ? 'Refresh location' : 'Enable location'}<Icon name="arrow" size={16}/></button>{locationError && <p className="inline-error" role="alert">{locationError}</p>}</section></div></div>{contactsView()}{historyView()}</>}
      {page === 'contacts' && contactsView()}{page === 'history' && historyView()}
      <footer className="main-footer"><span><Icon name="shield" size={15}/> Built around your circle of trust.</span><button className="text-button" onClick={() => open('help')}>How Signal works <Icon name="arrow" size={14}/></button></footer></>}
      </main></div>

    {modal === 'auth' && <Modal title={register ? 'Create your account' : 'Welcome back'} onClose={() => setModal(null)} locked={busy}><p className="dialog-description">{register ? 'A private workspace for your trusted contacts and SOS alerts.' : 'Sign in to manage your contacts and send an SOS.'}</p><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); run(async () => { await api(`/auth/${register ? 'register' : 'login'}`, Object.fromEntries(data)); await refresh(); setModal(null); setNotice(register ? 'Account created. Add your first trusted contact to get started.' : 'You’re signed in.'); }); }}>{register && <label>Your name<input name="name" autoComplete="name" required maxLength={80}/></label>}<label>Email address<input type="email" name="email" autoComplete="email" required maxLength={254}/></label><label>Password<input type="password" name="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 12 : 1} maxLength={128}/>{register && <small>Use at least 12 characters. Choose a unique password.</small>}</label>{formErrorView}<button className="button primary full" disabled={busy}>{busy ? 'Please wait…' : register ? 'Create account' : 'Sign in'}<Icon name="arrow" size={17}/></button></form><button className="text-button auth-switch" disabled={busy} onClick={() => { setRegister(!register); setFormError(''); }}>{register ? 'Already have an account? Sign in' : 'New here? Create an account'}</button><p className="caption">No email verification or password recovery is available in this version. Keep your password safe.</p></Modal>}
    {modal === 'contact' && <Modal title="Add a trusted contact" onClose={() => setModal(null)} locked={busy}><p className="dialog-description">Choose someone who has agreed to help. We’ll text them a verification code to share with you.</p>{!configured && <div className="banner warning">SMS delivery is not configured. The server administrator must connect Twilio before you can add a contact.</div>}<form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); run(async () => { const result = await api<{ contact: Contact }>('/contacts', { name: data.get('name'), phone: data.get('phone'), consent: data.get('consent') === 'on' }); setContacts(current => [...current, result.contact]); setModal(null); setVerifyContact(result.contact); }); }}><label>Contact’s name<input name="name" required maxLength={80} autoComplete="off" placeholder="e.g. Alex Morgan"/></label><label>Mobile number<input name="phone" type="tel" required pattern="\+[1-9][0-9]{7,14}" placeholder="+14155550123" autoComplete="off"/><small>Include the country code, starting with +. No spaces.</small></label><label className="checkbox-label"><input name="consent" type="checkbox" required/><span>This person has agreed to receive verification and SOS messages from me.</span></label>{formErrorView}<button className="button primary full" disabled={busy || !configured}>{busy ? 'Sending verification…' : 'Send verification code'}<Icon name="arrow" size={17}/></button></form></Modal>}
    {verifyContact && <Modal title="Verify this contact" onClose={() => { setVerifyContact(null); refresh().catch(e => setError(errText(e))); }} locked={busy}><p className="dialog-description">If <strong>{verifyContact.name}</strong> receives a six-digit code at {verifyContact.phone}, ask them to share it. Codes expire 10 minutes after being requested. SMS delivery is not guaranteed.</p><form onSubmit={e => { e.preventDefault(); const data = new FormData(e.currentTarget); run(async () => { const result = await api<{ contact: Contact }>(`/contacts/${verifyContact.id}/verify`, { code: data.get('code') }); setContacts(current => current.map(c => c.id === result.contact.id ? result.contact : c)); setVerifyContact(null); setNotice('Contact verified. They can now receive your SOS alerts.'); }); }}><label>Verification code<input name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" required minLength={6} maxLength={6}/></label>{formErrorView}<button className="button primary full" disabled={busy}>{busy ? 'Please wait…' : 'Verify contact'}</button></form><button className="text-button auth-switch" disabled={busy} onClick={() => run(async () => { await api(`/contacts/${verifyContact.id}/resend`, {}); setFormNotice('A new code was submitted to the SMS service. Ask your contact if it arrives.'); })}>Send a new code</button><p className="caption">Wait at least 60 seconds between codes. Messaging limits apply.</p><p className="caption">No code received? The account owner must check <a href="https://console.twilio.com/" target="_blank" rel="noopener noreferrer">Twilio Console</a> → Monitor → Logs → Messaging for the failure reason before retrying. Contact Twilio support if the error is unexplained.</p></Modal>}
    {removeContact && <Modal title="Remove trusted contact?" onClose={() => setRemoveContact(null)} locked={busy}><p className="dialog-description">{removeContact.name} will no longer receive your SOS alerts. Adding them again will require a new verification.</p>{formErrorView}<div className="dialog-actions"><button className="button secondary" disabled={busy} onClick={() => setRemoveContact(null)}>Keep contact</button><button className="button primary" disabled={busy} onClick={() => run(async () => { await api(`/contacts/${removeContact.id}`, undefined, 'DELETE'); setContacts(current => current.filter(c => c.id !== removeContact.id)); setRemoveContact(null); setNotice('Contact removed.'); })}>{busy ? 'Removing…' : 'Remove contact'}</button></div></Modal>}
    {modal === 'sos' && <Modal title="Review your SOS" onClose={() => setModal(null)} locked={busy}><p className="dialog-description">This sends a real SMS to your verified contacts. It does not contact emergency services.</p>{!ready ? <><div className="banner warning">{!configured ? 'SMS is not configured. Connect Twilio on the server before sending alerts.' : 'Add and verify at least one trusted contact before sending an alert.'}</div><button className="button secondary full" onClick={() => { setModal(null); navigate('contacts'); }}>Go to trusted contacts</button></> : <form onSubmit={e => { e.preventDefault(); run(async () => { const sharedLocation = includeLocation && location && Date.now() - location.timestamp < 5 * 60 * 1000 ? { latitude: location.latitude, longitude: location.longitude } : {}; if (includeLocation && location && !('latitude' in sharedLocation)) throw new Error('Your location is over five minutes old. Refresh it or uncheck location sharing.'); const data = await api<{ alert: Alert }>('/alerts', { message, ...sharedLocation, confirmed: true }); setAlerts(current => [data.alert, ...current.filter(a => a.id !== data.alert.id)]); setModal(null); setPage('history'); const failures = data.alert.recipients.filter(r => ['failed', 'undelivered', 'unknown'].includes(r.status)); setNotice(failures.length ? 'Alert recorded, but some messages failed or have an unknown status. Review the record below. Call for help if needed.' : 'Alert submitted to the SMS service. Check delivery status below; receipt is not guaranteed.'); }); }}><div className="recipient-summary"><span className="eyebrow">SEND TO {verified.length} VERIFIED CONTACT{verified.length !== 1 ? 'S' : ''}</span>{verified.map(c => <div key={c.id}><strong>{c.name}</strong><span>{c.phone}</span></div>)}</div><label>Your message<textarea value={message} onChange={e => setMessage(e.target.value)} required minLength={1} maxLength={300} rows={3}/><small>{message.length}/300 characters · SMS fees may apply.</small></label>{location ? <label className="checkbox-label"><input type="checkbox" checked={includeLocation} onChange={e => setIncludeLocation(e.target.checked)}/><span>Include my location, captured at {new Date(location.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. This is not live tracking.</span></label> : <p className="caption">No location available. Your alert can be sent without it.</p>}<button type="button" className="text-button" disabled={locating || busy} onClick={locate}><Icon name="pin" size={15}/>{locating ? 'Finding location…' : location ? 'Refresh location' : 'Get my location'}</button>{locationError && <p className="inline-error" role="alert">{locationError}</p>}{formErrorView}<div className="dialog-actions"><button type="button" className="button secondary" disabled={busy} onClick={() => setModal(null)}>Cancel</button><button className="button primary" disabled={busy || locating}>{busy ? 'Submitting…' : 'Confirm & send SOS'}<Icon name="arrow" size={17}/></button></div><p className="caption">Alerts have a 60-second cooldown. If a request times out, check history before trying again.</p></form>}</Modal>}
    {modal === 'help' && <Modal title="Know what to expect" onClose={() => setModal(null)}><div className="help-content"><h3>In immediate danger, call for help</h3><p>Use your local emergency number. For example, 112 in India and the EU, 911 in the US and Canada, or 999 in the UK. Availability depends on your location.</p><h3>A direct line to your people</h3><p>Signal sends SMS messages to contacts you have added and verified. It is not a monitored service and does not notify police, ambulance, or other emergency responders.</p><h3>Delivery isn’t guaranteed</h3><p>An internet connection and a configured Twilio service are required. Carrier issues, trial-account restrictions, or insufficient balance can prevent delivery. An accepted message is not proof of delivery or a response.</p><h3>Server setup</h3><p>The administrator must set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER in the server environment. Never enter these credentials in this interface.</p><h3>Your information</h3><p>Contacts and alert history are stored on this server. Location is requested only with permission and included in an alert only when you choose. There is no background location tracking.</p></div><button className="button secondary full" onClick={() => setModal(null)}>Understood</button></Modal>}
  </div>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
