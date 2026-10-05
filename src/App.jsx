import { useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { LangCtx } from './i18n.js';
import { Book, BookConfirm, PayTest, Callback, VerifyTest } from './pages/Booking.jsx';
import { Account } from './pages/Account.jsx';
import { Provider } from './pages/Provider.jsx';
import { Visit } from './pages/Visit.jsx';
import { startLogin } from './auth.js';

function Login() { startLogin('/account'); return <main className="wrap"><p>Opening secure sign-in…</p></main>; }

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
