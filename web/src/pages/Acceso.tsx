// Inicio de sesión, registro y verificación en dos pasos (TOTP) obligatoria.
import { useEffect, useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useSesion } from '../lib/sesion';
import { Boton, Campo, Entrada, Aviso } from '../components/ui';

export function Acceso() {
  const [modo, setModo] = useState<'entrar' | 'registro'>('entrar');
  const [correo, setCorreo] = useState('');
  const [clave, setClave] = useState('');
  const [nombre, setNombre] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [cargando, setCargando] = useState(false);

  async function enviar(e: FormEvent) {
    e.preventDefault();
    setError('');
    setInfo('');
    setCargando(true);
    try {
      if (modo === 'entrar') {
        const { error } = await supabase.auth.signInWithPassword({ email: correo, password: clave });
        if (error) throw new Error('Correo o clave incorrectos');
      } else {
        if (clave.length < 12) throw new Error('La clave debe tener al menos 12 caracteres');
        const { error } = await supabase.auth.signUp({ email: correo, password: clave, options: { data: { nombre } } });
        if (error) throw error;
        setInfo('Te enviamos un correo para confirmar la cuenta. Después podrás entrar.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }

  return (
    <div className="acceso">
      <div className="acceso-panel">
        <div className="marca grande"><span className="marca-logo" aria-hidden /> Cuadra</div>
        <p className="sub">Contabilidad y facturación electrónica para empresas en Chile.</p>
        <form onSubmit={enviar} className="form">
          {modo === 'registro' && (
            <Campo etiqueta="Nombre">
              <Entrada value={nombre} onChange={(e) => setNombre(e.target.value)} required autoComplete="name" />
            </Campo>
          )}
          <Campo etiqueta="Correo">
            <Entrada type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} required autoComplete="email" />
          </Campo>
          <Campo etiqueta="Clave" ayuda={modo === 'registro' ? 'Mínimo 12 caracteres, con mayúsculas, minúsculas, números y símbolos' : undefined}>
            <Entrada type="password" value={clave} onChange={(e) => setClave(e.target.value)} required autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'} />
          </Campo>
          <Aviso tipo="error">{error}</Aviso>
          <Aviso tipo="ok">{info}</Aviso>
          <Boton type="submit" cargando={cargando}>{modo === 'entrar' ? 'Entrar' : 'Crear cuenta'}</Boton>
        </form>
        <button className="enlace" onClick={() => setModo(modo === 'entrar' ? 'registro' : 'entrar')}>
          {modo === 'entrar' ? '¿No tienes cuenta? Regístrate' : '¿Ya tienes cuenta? Entra'}
        </button>
      </div>
      <div className="acceso-arte" aria-hidden>
        <div className="libro">
          {['Caja', 'Clientes', 'IVA crédito fiscal', 'Proveedores', 'IVA débito fiscal', 'Ventas'].map((c, i) => (
            <div key={c} className="libro-fila"><span>{c}</span><span className="mono">{i % 2 ? '' : '1.190.000'}</span><span className="mono">{i % 2 ? '1.190.000' : ''}</span></div>
          ))}
          <div className="libro-total"><span>Sumas iguales</span><span className="mono">3.570.000</span><span className="mono">3.570.000</span></div>
        </div>
      </div>
    </div>
  );
}

export function VerificacionMfa() {
  const { recargar } = useSesion();
  const [factorId, setFactorId] = useState<string | null>(null);
  const [qr, setQr] = useState<string | null>(null);
  const [secreto, setSecreto] = useState<string | null>(null);
  const [codigo, setCodigo] = useState('');
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.mfa.listFactors();
      const totp = data?.totp?.find((f) => f.status === 'verified');
      if (totp) {
        setFactorId(totp.id);
        return;
      }
      // Limpia inscripciones a medio terminar y crea una nueva
      for (const f of data?.all ?? []) if (f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      const { data: en, error } = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Cuadra ${new Date().toISOString().slice(0, 10)}` });
      if (error) return setError(error.message);
      setFactorId(en.id);
      setQr(en.totp.qr_code);
      setSecreto(en.totp.secret);
    })();
  }, []);

  async function verificar(e: FormEvent) {
    e.preventDefault();
    if (!factorId) return;
    setCargando(true);
    setError('');
    const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: codigo.replace(/\s/g, '') });
    setCargando(false);
    if (error) return setError('Código incorrecto o vencido');
    await supabase.auth.refreshSession();
    await recargar();
    location.reload();
  }

  return (
    <div className="acceso solo">
      <div className="acceso-panel">
        <div className="marca grande"><span className="marca-logo" aria-hidden /> Cuadra</div>
        <h2>Verificación en dos pasos</h2>
        {qr ? (
          <>
            <p className="sub">Para proteger la información contable y tu certificado digital, la verificación en dos pasos es obligatoria. Escanea el código con Google Authenticator, Microsoft Authenticator o 1Password.</p>
            <img src={qr} alt="Código QR para la app de autenticación" className="qr" />
            <p className="sub mono pequeno">Clave manual: {secreto}</p>
          </>
        ) : (
          <p className="sub">Ingresa el código de 6 dígitos de tu app de autenticación.</p>
        )}
        <form onSubmit={verificar} className="form">
          <Campo etiqueta="Código">
            <Entrada inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={codigo} onChange={(e) => setCodigo(e.target.value)} required autoFocus />
          </Campo>
          <Aviso tipo="error">{error}</Aviso>
          <Boton type="submit" cargando={cargando}>Verificar</Boton>
        </form>
        <button className="enlace" onClick={() => supabase.auth.signOut()}>Salir</button>
      </div>
    </div>
  );
}
