import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LangCtx } from './i18n.js';
import { Book, BookConfirm, PayTest, Callback, VerifyTest } from './pages/Booking.jsx';
import { Account } from './pages/Account.jsx';
import { Provider } from './pages/Provider.jsx';
import { Visit } from './pages/Visit.jsx';
import { startLogin } from './auth.js';
import { api } from './api.js';
import { ComingSoon } from './components/shared.jsx';

// While booking is closed, /login shows "opens soon" -- except ?provider=1,
// so Dr. Malik can still reach his workspace.
function Login() {
  const provider = new URLSearchParams(location.search).get('provider') === '1';
  const [open, setOpen] = useState(provider ? true : null);
  useEffect(() => { if (!provider) api('/config').then((c) => setOpen(Boolean(c.bookingOpen))).catch(() => setOpen(false)); }, [provider]);
  useEffect(() => { if (open) startLogin(provider ? '/provider' : '/account'); }, [open, provider]);
  if (open === false) return <ComingSoon providerLink />;
  return <main className="wrap"><p>Opening secure sign-in…</p></main>;
}

export default function App() {
  const [lang, setLang] = useState(() => (navigator.language || '').startsWith('es') ? 'es' : 'en');
  return (
    <LangCtx.Provider value={{ lang, setLang }}>
      <BrowserRouter>
        <Routes>
          <Route path="/auth/callback" element={<Callback />} />
          <Route path="/login" element={<Login />} />
          <Route path="/" element={<Navigate to="/book" replace />} />
          <Route path="/book" element={<Book />} />
          <Route path="/book/confirm" element={<BookConfirm />} />
          <Route path="/pay/test" element={<PayTest />} />
          <Route path="/verify/test" element={<VerifyTest />} />
          <Route path="/account" element={<Account />} />
          <Route path="/provider" element={<Provider />} />
          <Route path="/visit/:id" element={<Visit />} />
          <Route path="*" element={<Navigate to="/book" replace />} />
        </Routes>
      </BrowserRouter>
    </LangCtx.Provider>
  );
}
