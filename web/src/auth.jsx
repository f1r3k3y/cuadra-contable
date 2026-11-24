import { useEffect, useState } from 'react';
import { sb } from './supabase';

export function Login() {
  const [modo, setModo] = useState('entrar');
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [nombre, setNombre] = useState('');
  const [msg, setMsg] = useState(null);
  const [ocupado, setOcupado] = useState(false);

  async function enviar(e) {
    e.preventDefault();
    setMsg(null);
    setOcupado(true);
    try {
      if (modo === 'entrar') {
        const { error } = await sb.auth.signInWithPassword({ email: correo.trim(), password: clave });
        if (error) throw new Error('Correo o contraseña incorrectos.');
      } else if (modo === 'registro') {
        if (clave.length < 12 || !/[a-zA-Z]/.test(clave) || !/\d/.test(clave)) throw new Error('Usa al menos 12 caracteres, con letras y números.');
        const { error } = await sb.auth.signUp({ email: correo.trim(), password: clave, options: { data: { nombre: nombre.trim() } } });
        if (error) throw error;
        setMsg({ ok: true, t: 'Te enviamos un correo para confirmar la cuenta. Luego entra con tu contraseña.' });
        setModo('entrar');
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(correo.trim(), { redirectTo: window.location.origin });
        if (error) throw error;
        setMsg({ ok: true, t: 'Si el correo existe, recibirás un enlace para cambiar la contraseña.' });
      }
    } catch (err) {
      setMsg({ ok: false, t: err.message });
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="acceso">
      <form className="tarjeta-acceso" onSubmit={enviar}>
        <div className="marca"><span className="logo">C</span> Cuadra Contable</div>
        <h1>{modo === 'entrar' ? 'Entrar' : modo === 'registro' ? 'Crear cuenta' : 'Recuperar contraseña'}</h1>
        {modo === 'registro' && (
          <label>Nombre<input value={nombre} onChange={(e) => setNombre(e.target.value)} required maxLength={80} /></label>
        )}
        <label>Correo<input type="email" autoComplete="username" value={correo} onChange={(e) => setCorreo(e.target.value)} required /></label>
        {modo !== 'recuperar' && (
          <label>Contraseña
            <input type="password" autoComplete={modo === 'registro' ? 'new-password' : 'current-password'} value={clave} onChange={(e) => setClave(e.target.value)} required minLength={modo === 'registro' ? 12 : 1} />
          </label>
        )}
        {msg && <p className={msg.ok ? 'aviso ok' : 'aviso error'}>{msg.t}</p>}
        <button className="primario" disabled={ocupado}>{ocupado ? 'Un momento…' : 'Continuar'}</button>
        <div className="enlaces">
          {modo !== 'entrar' && <button type="button" className="enlace" onClick={() => setModo('entrar')}>Ya tengo cuenta</button>}
          {modo !== 'registro' && <button type="button" className="enlace" onClick={() => setModo('registro')}>Crear cuenta</button>}
          {modo !== 'recuperar' && <button type="button" className="enlace" onClick={() => setModo('recuperar')}>Olvidé mi contraseña</button>}
        </div>
      </form>
    </div>
  );
}

// Verificación en dos pasos (TOTP). La base de datos rechaza toda escritura sin nivel aal2.
export function DosPasos({ alListo }) {
  const [factor, setFactor] = useState(null);
  const [qr, setQr] = useState(null);
  const [secreto, setSecreto] = useState(null);
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await sb.auth.mfa.listFactors();
      if (error) return setError(error.message);
      const verificado = data.totp.find((f) => f.status === 'verified');
      if (verificado) return setFactor(verificado.id);
      // Limpia inscripciones a medias y crea una nueva
      for (const f of data.all.filter((f) => f.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id });
      const r = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'Cuadra ' + new Date().toISOString().slice(0, 10) });
      if (r.error) return setError(r.error.message);
      setFactor(r.data.id);
      const svg = r.data.totp.qr_code;
      setQr(svg.startsWith('data:') ? svg : 'data:image/svg+xml;utf8,' + encodeURIComponent(svg));
      setSecreto(r.data.totp.secret);
    })();
  }, []);

  async function verificar(e) {
    e.preventDefault();
    setError(null);
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: factor, code: codigo.trim() });
    if (error) return setError('Código incorrecto o vencido. Intenta con el código actual.');
    alListo();
  }

  return (
    <div className="acceso">
      <form className="tarjeta-acceso" onSubmit={verificar}>
        <div className="marca"><span className="logo">C</span> Cuadra Contable</div>
        <h1>Verificación en dos pasos</h1>
        {qr ? (
          <>
            <p>Escanea este código con Google Authenticator, Microsoft Authenticator o similar. Es obligatorio para registrar o modificar información contable.</p>
            <img className="qr" src={qr} alt="Código QR para la app de autenticación" />
            <p className="chico">¿No puedes escanear? Ingresa esta clave: <code>{secreto}</code></p>
          </>
        ) : (
          <p>Ingresa el código de 6 dígitos de tu app de autenticación.</p>
        )}
        <label data-ayuda="Código de 6 dígitos que muestra tu app de autenticación (Google Authenticator, Microsoft Authenticator u otra). Cambia cada 30 segundos.">Código<input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value)} required autoFocus /></label>
        {error && <p className="aviso error">{error}</p>}
        <button className="primario" disabled={!factor}>Verificar</button>
        <button type="button" className="enlace" onClick={() => sb.auth.signOut()}>Salir</button>
      </form>
    </div>
  );
}

export function NuevaClave({ alListo }) {
  const [clave, setClave] = useState('');
  const [error, setError] = useState(null);
  async function guardar(e) {
    e.preventDefault();
    if (clave.length < 12 || !/[a-zA-Z]/.test(clave) || !/\d/.test(clave)) return setError('Usa al menos 12 caracteres, con letras y números.');
    const { error } = await sb.auth.updateUser({ password: clave });
    if (error) return setError(error.message);
    alListo();
  }
  return (
    <div className="acceso">
      <form className="tarjeta-acceso" onSubmit={guardar}>
        <h1>Nueva contraseña</h1>
        <label>Contraseña<input type="password" autoComplete="new-password" value={clave} onChange={(e) => setClave(e.target.value)} required /></label>
        {error && <p className="aviso error">{error}</p>}
        <button className="primario">Guardar</button>
      </form>
    </div>
  );
}
