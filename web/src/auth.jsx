import { useEffect, useState } from 'react';
import { rpc, sb } from './supabase';
import Turnstile from './Turnstile';
import { ROLES } from './util';

export function Login() {
  const [invitacion, setInvitacion] = useState(null);
  const [modo, setModo] = useState(sessionStorage.getItem('invitacion') ? 'registro' : 'entrar');
  useEffect(() => {
    const token = sessionStorage.getItem('invitacion');
    if (!token) return;
    rpc('ver_invitacion', { p_token: token }).then((i) => {
      setInvitacion(i ?? { invalida: true });
      if (i?.correo) setCorreo(i.correo);
    }).catch(() => setInvitacion({ invalida: true }));
  }, []);
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [nombre, setNombre] = useState('');
  const [msg, setMsg] = useState(null);
  const [ocupado, setOcupado] = useState(false);
  const [captcha, setCaptcha] = useState(null);
  const [reinicio, setReinicio] = useState(0);
  const captchaToken = captcha && captcha !== 'sin-captcha' ? captcha : undefined;

  async function enviar(e) {
    e.preventDefault();
    setMsg(null);
    setOcupado(true);
    try {
      if (modo === 'entrar') {
        const { error } = await sb.auth.signInWithPassword({ email: correo.trim(), password: clave, options: { captchaToken } });
        if (error) throw new Error('Correo o contraseña incorrectos.');
      } else if (modo === 'registro') {
        if (clave.length < 12 || !/[a-zA-Z]/.test(clave) || !/\d/.test(clave)) throw new Error('Usa al menos 12 caracteres, con letras y números.');
        const { data, error } = await sb.auth.signUp({ email: correo.trim(), password: clave, options: { data: { nombre: nombre.trim() }, captchaToken } });
        if (error) throw error;
        if (!data.session) {
          setMsg({ ok: true, t: 'Te enviamos un correo para confirmar la cuenta. Luego entra con tu contraseña.' });
          setModo('entrar');
        }
      } else {
        const { error } = await sb.auth.resetPasswordForEmail(correo.trim(), { redirectTo: window.location.origin, captchaToken });
        if (error) throw error;
        setMsg({ ok: true, t: 'Si el correo existe, recibirás un enlace para cambiar la contraseña.' });
      }
    } catch (err) {
      setMsg({ ok: false, t: err.message });
    } finally {
      setOcupado(false);
      setReinicio((n) => n + 1); // cada token de verificación sirve una sola vez
    }
  }

  return (
    <div className="acceso">
      <form className="tarjeta-acceso" onSubmit={enviar}>
        <div className="marca"><span className="logo">C</span> Cuadra Contable</div>
        <h1>{modo === 'entrar' ? 'Entrar' : modo === 'registro' ? 'Crear cuenta' : 'Recuperar contraseña'}</h1>
        {invitacion && !invitacion.invalida && (invitacion.vigente
          ? <p className="aviso ok" role="status">Te invitaron a <b>{invitacion.empresa}</b> como <b>{ROLES[invitacion.rol] ?? invitacion.rol}</b>. {modo === 'registro' ? 'Crea tu cuenta' : 'Entra'} con <b>{invitacion.correo}</b> para unirte.</p>
          : <p className="aviso error" role="alert">Esta invitación ya no está disponible ({invitacion.estado === 'pendiente' ? 'venció' : invitacion.estado}). Pide una nueva al administrador.</p>)}
        {invitacion?.invalida && <p className="aviso error" role="alert">El enlace de invitación no es válido. Revisa que lo hayas copiado completo.</p>}
        {modo === 'registro' && (
          <label>Nombre<input value={nombre} onChange={(e) => setNombre(e.target.value)} required maxLength={80} /></label>
        )}
        <label>Correo<input type="email" autoComplete="username" value={correo} onChange={(e) => setCorreo(e.target.value)} required /></label>
        {modo !== 'recuperar' && (
          <label>Contraseña
            <input type="password" autoComplete={modo === 'registro' ? 'new-password' : 'current-password'} value={clave} onChange={(e) => setClave(e.target.value)} required minLength={modo === 'registro' ? 12 : 1} />
          </label>
        )}
        <Turnstile accion={modo === 'entrar' ? 'login' : modo === 'registro' ? 'signup' : 'recuperar'} alToken={setCaptcha} reinicio={reinicio} />
        {msg && <p className={msg.ok ? 'aviso ok' : 'aviso error'} role={msg.ok ? 'status' : 'alert'}>{msg.t}</p>}
        <button className="primario" disabled={ocupado || !captcha}>{ocupado ? 'Un momento…' : !captcha ? 'Verificando…' : 'Continuar'}</button>
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
  const [verificados, setVerificados] = useState([]);
  const [qr, setQr] = useState(null);
  const [secreto, setSecreto] = useState(null);
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState(null);

  useEffect(() => {
    (async () => {
      const { data, error } = await sb.auth.mfa.listFactors();
      if (error) return setError(error.message);
      const verificados = data.totp.filter((f) => f.status === 'verified');
      if (verificados.length) { setVerificados(verificados); return setFactor(verificados[0].id); }
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
        {verificados.length > 1 && (
          <label>Dispositivo<select value={factor ?? ''} onChange={(e) => setFactor(e.target.value)}>
            {verificados.map((f) => <option key={f.id} value={f.id}>{f.friendly_name || 'Autenticador'}</option>)}
          </select></label>
        )}
        <label data-ayuda="Código de 6 dígitos que muestra tu app de autenticación (Google Authenticator, Microsoft Authenticator u otra). Cambia cada 30 segundos.">Código<input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={codigo} onChange={(e) => setCodigo(e.target.value)} required autoFocus /></label>
        {error && <p className="aviso error" role="alert">{error}</p>}
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
        {error && <p className="aviso error" role="alert">{error}</p>}
        <button className="primario">Guardar</button>
      </form>
    </div>
  );
}

// Autenticadores del usuario: permite agregar uno de respaldo (otro celular) y quitar los que sobran.
export function MisAutenticadores() {
  const [factores, setFactores] = useState(null);
  const [nuevo, setNuevo] = useState(null);
  const [msg, setMsg] = useState(null);

  async function cargar() {
    const { data, error } = await sb.auth.mfa.listFactors();
    if (error) return setMsg({ ok: false, t: error.message });
    setFactores(data.totp.filter((f) => f.status === 'verified'));
    // Limpia inscripciones a medias
    for (const f of data.all.filter((f) => f.status !== 'verified')) await sb.auth.mfa.unenroll({ factorId: f.id });
  }
  useEffect(() => { cargar(); }, []);

  async function agregar() {
    setMsg(null);
    const nombre = 'Respaldo ' + new Date().toLocaleDateString('es-CL');
    const r = await sb.auth.mfa.enroll({ factorType: 'totp', friendlyName: nombre + ' ' + Math.random().toString(36).slice(2, 6) });
    if (r.error) return setMsg({ ok: false, t: r.error.message });
    const svg = r.data.totp.qr_code;
    setNuevo({ id: r.data.id, qr: svg.startsWith('data:') ? svg : 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), secreto: r.data.totp.secret, codigo: '' });
  }

  async function verificar(e) {
    e.preventDefault();
    const { error } = await sb.auth.mfa.challengeAndVerify({ factorId: nuevo.id, code: nuevo.codigo.trim() });
    if (error) return setNuevo({ ...nuevo, error: 'Código incorrecto o vencido. Usa el código que muestra ahora el nuevo celular.' });
    setNuevo(null);
    setMsg({ ok: true, t: 'Autenticador de respaldo agregado. Puedes entrar con cualquiera de los dos.' });
    cargar();
  }

  async function cancelar() {
    if (nuevo) await sb.auth.mfa.unenroll({ factorId: nuevo.id });
    setNuevo(null);
  }

  async function quitar(f) {
    setMsg(null);
    if (factores.length < 2) return;
    const { error } = await sb.auth.mfa.unenroll({ factorId: f.id });
    if (error) return setMsg({ ok: false, t: error.message });
    setMsg({ ok: true, t: 'Autenticador quitado.' });
    cargar();
  }

  return (
    <div className="formulario">
      <h2>Mi verificación en dos pasos</h2>
      <p className="chico">Si pierdes el celular sin un respaldo, no podrás entrar. Agrega un segundo autenticador en otro dispositivo (otro celular, una tableta o un gestor de contraseñas con códigos).</p>
      {msg && <p className={msg.ok ? 'aviso ok' : 'aviso error'} role={msg.ok ? 'status' : 'alert'}>{msg.t}</p>}
      {factores && (
        <table className="tabla"><tbody>
          {factores.map((f) => (
            <tr key={f.id}><td>{f.friendly_name || 'Autenticador'}</td><td className="chico">desde {new Date(f.created_at).toLocaleDateString('es-CL')}</td>
              <td>{factores.length > 1 && <button className="enlace" onClick={() => quitar(f)}>Quitar</button>}</td></tr>
          ))}
        </tbody></table>
      )}
      {factores && factores.length === 1 && !nuevo && <p className="aviso error" role="status">Tienes un solo autenticador: si pierdes ese dispositivo quedarás sin acceso.</p>}
      {!nuevo ? <div className="acciones"><button onClick={agregar}>+ Agregar autenticador de respaldo</button></div> : (
        <form onSubmit={verificar}>
          <p>Escanea este código con el <b>otro</b> dispositivo y escribe el código que muestra.</p>
          <img className="qr" src={nuevo.qr} alt="Código QR para el autenticador de respaldo" />
          <p className="chico">¿No puedes escanear? Clave: <code>{nuevo.secreto}</code></p>
          <label>Código del nuevo dispositivo<input inputMode="numeric" autoComplete="one-time-code" pattern="\d{6}" maxLength={6} value={nuevo.codigo} onChange={(e) => setNuevo({ ...nuevo, codigo: e.target.value })} required autoFocus /></label>
          {nuevo.error && <p className="aviso error" role="alert">{nuevo.error}</p>}
          <div className="acciones"><button type="button" onClick={cancelar}>Cancelar</button><button className="primario">Verificar y agregar</button></div>
        </form>
      )}
    </div>
  );
}
