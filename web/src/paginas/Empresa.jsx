import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Aviso, CampoMonto, Dialogo } from '../componentes';
import { MisAutenticadores } from '../auth';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { MESES, PERMISOS, ROLES, ROL_DESC, peso, rutFormato } from '../util';

export default function Empresa() {
  const { empresa, permite, rol, usuario, recargarEmpresas } = useEmpresa();
  const [datos, setDatos] = useState(null);
  const [miembros, setMiembros] = useState([]);
  const [periodos, setPeriodos] = useState([]);
  const [invitar, setInvitar] = useState({ correo: '', rol: 'contador' });
  const [msg, setMsg] = useState(null);
  const admin = permite('empresa.editar');
  const gestionaUsuarios = permite('usuarios.gestionar');
  const ve = permite('empresa.ver');
  const cierra = permite('periodos.cerrar');
  const reabre = permite('periodos.reabrir');
  const audita = permite('auditoria.ver');
  const [matriz, setMatriz] = useState(null);
  const [cierre, setCierre] = useState(null);
  const [invitaciones, setInvitaciones] = useState([]);
  const [enlace, setEnlace] = useState(null);

  const cargar = useCallback(async () => {
    const [d, m, p] = await Promise.all([
      q(sb.from('empresas').select('*').eq('id', empresa.id).single()),
      q(sb.from('miembros').select('user_id, rol, creado_en, perfiles(nombre)').eq('empresa_id', empresa.id)),
      q(sb.from('periodos').select('*').eq('empresa_id', empresa.id).order('anio', { ascending: false }).order('mes', { ascending: false })),
    ]);
    setDatos(d); setMiembros(m); setPeriodos(p);
    if (permite('usuarios.gestionar')) {
      setInvitaciones(await q(sb.from('invitaciones').select('id, correo, rol, estado, creado_en, expira_en').eq('empresa_id', empresa.id)
        .order('creado_en', { ascending: false }).limit(50)));
    }
    setMatriz(await rpc('matriz_permisos'));
  }, [empresa.id, audita]);
  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  const hacer = (fn, ok) => async (e) => {
    e?.preventDefault();
    setMsg(null);
    try { await fn(); setMsg({ ok: true, t: ok }); cargar(); } catch (err) { setMsg({ ok: false, t: err.message }); }
  };

  const guardarDatos = hacer(async () => {
    const { razon_social, nombre_fantasia, giro, direccion, comuna, ciudad, correo, telefono, tasa_ppm, remanente_inicial } = datos;
    await q(sb.from('empresas').update({ razon_social, nombre_fantasia, giro, direccion, comuna, ciudad, correo, telefono, tasa_ppm: Number(tasa_ppm), remanente_inicial: Number(remanente_inicial) }).eq('id', empresa.id));
    await recargarEmpresas();
  }, 'Datos guardados.');

  const set = (k) => (e) => setDatos({ ...datos, [k]: e.target.value });

  if (!datos) return <section className="hoja">{msg ? <p className="aviso error">{msg.t}</p> : <p>Cargando…</p>}</section>;

  return (
    <section className="hoja">
      <header className="cabecera"><div><h1>{datos.razon_social}</h1><p className="chico">RUT {rutFormato(datos.rut)}</p></div></header>
      <Aviso msg={msg} />

      <div className="tu-rol">
        <b>Tu rol: {ROLES[rol]}</b>
        <span>{ROL_DESC[rol]}</span>
      </div>

      <div className="dos-columnas">
        {ve && <form className="formulario" onSubmit={guardarDatos}>
          <h2>Datos de la empresa</h2>
          <fieldset disabled={!admin}>
            <label>Razón social<input value={datos.razon_social} onChange={set('razon_social')} required /></label>
            <label>Nombre de fantasía<input value={datos.nombre_fantasia ?? ''} onChange={set('nombre_fantasia')} /></label>
            <label>Giro<input value={datos.giro} onChange={set('giro')} required /></label>
            <label>Dirección<input value={datos.direccion} onChange={set('direccion')} /></label>
            <label>Comuna<input value={datos.comuna} onChange={set('comuna')} /></label>
            <label>Correo<input type="email" value={datos.correo ?? ''} onChange={set('correo')} /></label>
            <label>Tasa PPM (%)<input type="number" step="0.001" min="0" max="10" value={datos.tasa_ppm} onChange={set('tasa_ppm')} /></label>
            <label>Remanente de crédito fiscal inicial ($)<CampoMonto valor={String(datos.remanente_inicial ?? '')} alCambiar={(v) => setDatos({ ...datos, remanente_inicial: v })} /></label>
            {admin && <div className="acciones"><button className="primario">Guardar datos</button></div>}
          </fieldset>
        </form>}

        <div>
          {ve && <>
          <h2>Usuarios y roles</h2>
          <table className="tabla"><tbody>
            {miembros.map((m) => (
              <tr key={m.user_id}>
                <td>{m.perfiles?.nombre ?? '—'}{m.user_id === usuario.id && <small> · tú</small>}</td>
                <td>{gestionaUsuarios && m.user_id !== usuario.id ? (
                  <select value={m.rol} aria-label="Rol" onChange={(e) => hacer(() => q(sb.from('miembros').update({ rol: e.target.value }).eq('empresa_id', empresa.id).eq('user_id', m.user_id)), 'Rol actualizado.')()}>
                    {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>) : ROLES[m.rol]}</td>
                <td>{gestionaUsuarios && m.user_id !== usuario.id && <button className="enlace" onClick={hacer(() => q(sb.from('miembros').delete().eq('empresa_id', empresa.id).eq('user_id', m.user_id)), 'Usuario quitado de la empresa.')}>Quitar</button>}</td>
              </tr>
            ))}
          </tbody></table>
          {gestionaUsuarios && (
            <form className="formulario en-fila" onSubmit={hacer(async () => {
              const token = await rpc('crear_invitacion', { p_empresa: empresa.id, p_correo: invitar.correo, p_rol: invitar.rol });
              setEnlace({ url: `${window.location.origin}/#invitacion=${token}`, correo: invitar.correo.trim().toLowerCase(), rol: invitar.rol, copiado: false });
              setInvitar({ ...invitar, correo: '' });
            }, 'Invitación creada: copia el enlace y envíalo.')}>
              <label>Correo de la persona<input type="email" value={invitar.correo} onChange={(e) => setInvitar({ ...invitar, correo: e.target.value })} required /></label>
              <label>Rol<select value={invitar.rol} onChange={(e) => setInvitar({ ...invitar, rol: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <button className="primario">Invitar</button>
            </form>
          )}
          {enlace && (
            <div className="enlace-invitacion" role="status">
              <p>Enlace para <b>{enlace.correo}</b> como <b>{ROLES[enlace.rol]}</b> (vence en 7 días, sirve una sola vez). Solo se muestra ahora: cópialo y envíalo.</p>
              <input readOnly value={enlace.url} onFocus={(e) => e.target.select()} aria-label="Enlace de invitación" />
              <div className="acciones">
                <button className="primario" onClick={async () => { try { await navigator.clipboard.writeText(enlace.url); setEnlace({ ...enlace, copiado: true }); } catch { /* sin permiso de portapapeles */ } }}>{enlace.copiado ? 'Copiado ✓' : 'Copiar enlace'}</button>
                <a className="boton" href={`https://wa.me/?text=${encodeURIComponent(`Te invito a probar Cuadra Contable (${datos.razon_social}). Crea tu cuenta con ${enlace.correo} aquí: ${enlace.url}`)}`} target="_blank" rel="noopener noreferrer">Enviar por WhatsApp</a>
                <a className="boton" href={`mailto:${enlace.correo}?subject=${encodeURIComponent('Invitación a Cuadra Contable')}&body=${encodeURIComponent(`Hola,\n\nTe invito a probar Cuadra Contable en la empresa ${datos.razon_social}.\nCrea tu cuenta con este correo (${enlace.correo}) desde este enlace:\n${enlace.url}\n\nEl enlace vence en 7 días.`)}`}>Enviar por correo</a>
                <button onClick={() => setEnlace(null)}>Listo</button>
              </div>
            </div>
          )}
          {gestionaUsuarios && invitaciones.some((i) => i.estado === 'pendiente') && (
            <>
              <h3>Invitaciones pendientes</h3>
              <table className="tabla compacta"><tbody>
                {invitaciones.filter((i) => i.estado === 'pendiente').map((i) => {
                  const vencida = new Date(i.expira_en) < new Date();
                  return (
                    <tr key={i.id}><td>{i.correo}</td><td>{ROLES[i.rol]}</td>
                      <td className="chico">{vencida ? 'vencida' : 'vence ' + new Date(i.expira_en).toLocaleDateString('es-CL')}</td>
                      <td className="nw">
                        <button className="enlace" onClick={() => setInvitar({ correo: i.correo, rol: i.rol })}>Nuevo enlace</button>{' '}
                        <button className="enlace" onClick={hacer(() => rpc('revocar_invitacion', { p_id: i.id }), 'Invitación revocada.')}>Revocar</button>
                      </td></tr>
                  );
                })}
              </tbody></table>
            </>
          )}
          {gestionaUsuarios && <p className="chico">La persona recibe un enlace, crea su cuenta con ese mismo correo y queda con el rol elegido. Revisa abajo qué puede hacer cada rol.</p>}

          </>}
          <h2>Períodos contables</h2>
          <p className="chico">Un mes cerrado no acepta asientos nuevos ni anulaciones.</p>
          <table className="tabla"><tbody>
            {periodos.map((p) => (
              <tr key={p.anio * 100 + p.mes}>
                <td>{MESES[p.mes - 1]} {p.anio}</td><td><span className={'etiqueta ' + (p.estado === 'cerrado' ? 'anulado' : 'contabilizado')}>{p.estado}</span></td>
                <td>{(p.estado === 'abierto'
                  ? cierra && <button className="enlace" onClick={() => setCierre(p)}>Cerrar</button>
                  : reabre && <button className="enlace" onClick={hacer(() => rpc('reabrir_periodo', { p_empresa: empresa.id, p_anio: p.anio, p_mes: p.mes }), 'Período reabierto.')}>Reabrir</button>)}</td>
              </tr>
            ))}
          </tbody></table>
          {cierra && <CierreEjercicio empresa={empresa} />}
        </div>
      </div>

      {matriz && (
        <>
          <h2>Qué puede hacer cada rol</h2>
          <p className="chico">Los permisos se aplican en la base de datos. Basados en la segregación de funciones: quien registra no aprueba, y quien mueve el dinero no contabiliza.</p>
          <div className="scroll">
            <table className="tabla compacta matriz">
              <thead><tr><th>Permiso</th>{Object.keys(ROLES).map((r) => <th key={r} className={'c' + (r === rol ? ' actual' : '')}>{ROLES[r]}</th>)}</tr></thead>
              <tbody>{Object.entries(PERMISOS).map(([p, t]) => (
                <tr key={p}><td>{t}</td>{Object.keys(ROLES).map((r) => <td key={r} className={'c' + (r === rol ? ' actual' : '')}>{(matriz[r] ?? []).includes(p) ? '●' : ''}</td>)}</tr>
              ))}</tbody>
            </table>
          </div>
          <dl className="roles-desc">{Object.entries(ROL_DESC).map(([r, d]) => <div key={r}><dt>{ROLES[r]}</dt><dd>{d}</dd></div>)}</dl>
        </>
      )}

      <AlertasCorreo empresa={empresa} usuario={usuario} />

      <MisAutenticadores />

      {cierre && (
        <Dialogo titulo={`Cerrar ${MESES[cierre.mes - 1]} ${cierre.anio}`} alCerrar={() => setCierre(null)}>
          <form onSubmit={async (e) => { e.preventDefault(); const p = cierre; setCierre(null); await hacer(() => rpc('cerrar_periodo', { p_empresa: empresa.id, p_anio: p.anio, p_mes: p.mes }), `${MESES[p.mes - 1]} ${p.anio} cerrado.`)(); }}>
            <h2>Cerrar {MESES[cierre.mes - 1]} {cierre.anio}</h2>
            <p>Un mes cerrado no acepta documentos, asientos, cobros ni anulaciones con esa fecha. Solo un administrador puede reabrirlo.</p>
            <p className="chico">Si quedan borradores por aprobar en el mes, el cierre se rechaza: apruébalos o elimínalos antes.</p>
            <div className="acciones"><button type="button" onClick={() => setCierre(null)}>Cancelar</button><button className="peligro">Cerrar el mes</button></div>
          </form>
        </Dialogo>
      )}

      {audita && <p className="nota">El registro completo de cambios (quién, qué, cuándo, desde qué IP) está en <Link to="/auditoria">Auditoría</Link>.</p>}
    </section>
  );
}

// Asiento de cierre anual: deja en cero las cuentas de resultado y lleva la utilidad o pérdida al patrimonio.
function CierreEjercicio({ empresa }) {
  const actual = new Date().getFullYear();
  const [anio, setAnio] = useState(new Date().getMonth() === 11 ? actual : actual - 1);
  const [est, setEst] = useState(null);
  const [confirmar, setConfirmar] = useState(false);
  const [msg, setMsg] = useState(null);
  const cargar = useCallback(() => {
    setEst(null);
    rpc('estado_ejercicio', { p_empresa: empresa.id, p_anio: anio }).then(setEst).catch((e) => setMsg({ ok: false, t: e.message }));
  }, [empresa.id, anio]);
  useEffect(() => { cargar(); }, [cargar]);
  const disponible = anio < actual || new Date().getMonth() === 11;

  async function cerrar(e) {
    e.preventDefault();
    setConfirmar(false);
    try {
      const a = await rpc('cerrar_ejercicio', { p_empresa: empresa.id, p_anio: anio });
      setMsg({ ok: true, t: `Ejercicio ${anio} cerrado con el asiento N° ${a.numero}.` });
      cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  return (
    <>
      <h2>Cierre del ejercicio</h2>
      <p className="chico">Al terminar el año, las cuentas de ingresos y gastos quedan en cero y la utilidad o pérdida pasa a «Resultado del ejercicio» (3.1.03). El resultado del año anterior se traspasa a «Resultados acumulados» (3.1.02). Los informes del año siguen mostrando el resultado.</p>
      <label className="en-linea">Año<select value={anio} onChange={(e) => setAnio(Number(e.target.value))}>
        {[actual, actual - 1, actual - 2, actual - 3].map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
      <Aviso msg={msg} />
      {est && (est.cerrado
        ? <p><span className="etiqueta contabilizado">cerrado</span> con el asiento N° {est.asiento.numero}. Para rehacerlo, anule ese asiento en Asientos.</p>
        : <>
          <p>Resultado {anio}: <b>{peso(est.resultado)}</b> {Number(est.resultado) >= 0 ? '(utilidad)' : '(pérdida)'}
            {est.borradores > 0 && <><br /><span className="error-texto">{est.borradores} borradores pendientes en {anio}: apruébalos o elimínalos antes de cerrar.</span></>}
            {est.mesesAbiertos > 0 && <><br /><small>{est.mesesAbiertos} meses de {anio} siguen abiertos; conviene cerrarlos después del cierre anual.</small></>}</p>
          <button disabled={!disponible || est.borradores > 0} onClick={() => setConfirmar(true)}>Generar asiento de cierre {anio}</button>
          {!disponible && <p className="chico">El cierre de {anio} se habilita en diciembre.</p>}
        </>)}
      {confirmar && (
        <Dialogo titulo={`Cerrar el ejercicio ${anio}`} alCerrar={() => setConfirmar(false)}>
          <form onSubmit={cerrar}>
            <h2>Cerrar el ejercicio {anio}</h2>
            <p>Se crea y contabiliza un asiento al 31-12-{anio} que deja las cuentas de resultado en cero y lleva {peso(Math.abs(Number(est.resultado)))} de {Number(est.resultado) >= 0 ? 'utilidad' : 'pérdida'} al patrimonio.</p>
            <p className="chico">Se puede deshacer anulando el asiento mientras diciembre esté abierto.</p>
            <div className="acciones"><button type="button" onClick={() => setConfirmar(false)}>Cancelar</button><button className="primario">Generar asiento</button></div>
          </form>
        </Dialogo>
      )}
    </>
  );
}

// Alertas por correo: cada usuario decide si las recibe para esta empresa (plazos del F29 y Previred, pagos por vencer, pendientes de la semana).
function AlertasCorreo({ empresa, usuario }) {
  const [activo, setActivo] = useState(null);
  const [envios, setEnvios] = useState([]);
  const [msg, setMsg] = useState(null);
  const [enviando, setEnviando] = useState(false);
  const cargar = useCallback(async () => {
    const [p, e] = await Promise.all([
      q(sb.from('preferencias_alertas').select('activo').eq('empresa_id', empresa.id).eq('user_id', usuario.id).maybeSingle()),
      q(sb.from('envios_alertas').select('fecha, estado, error, creado_en').eq('user_id', usuario.id).order('creado_en', { ascending: false }).limit(5)),
    ]);
    setActivo(!!p?.activo); setEnvios(e);
  }, [empresa.id, usuario.id]);
  useEffect(() => { cargar().catch((err) => setMsg({ ok: false, t: err.message })); }, [cargar]);

  async function cambiar(v) {
    try { await rpc('guardar_preferencia_alertas', { p_empresa: empresa.id, p_activo: v }); setActivo(v); setMsg({ ok: true, t: v ? `Recibirás las alertas de ${empresa.razon_social} en ${usuario.email}.` : 'Alertas desactivadas para esta empresa.' }); }
    catch (err) { setMsg({ ok: false, t: err.message }); }
  }
  async function probar() {
    setEnviando(true); setMsg(null);
    try {
      const { data, error } = await sb.functions.invoke('alertas', { body: { prueba: true } });
      if (error) { let t = error.message; try { t = (await error.context.json()).error ?? t; } catch { /* sin detalle */ } throw new Error(t); }
      setMsg({ ok: true, t: `Correo de prueba enviado a ${data.correo}. Revisa también la carpeta de spam.` }); cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); } finally { setEnviando(false); }
  }
  if (activo === null) return null;
  return (
    <>
      <h2>Alertas por correo</h2>
      <p className="chico">Un correo por la mañana, solo cuando hay algo que atender: F29 por vencer (del 14 al 20), cotizaciones en Previred (del 9 al 13), pagos que vencen en 3 días y, los lunes, vencidos, aprobaciones y cartola pendiente. Cada aviso depende de tu rol.</p>
      <label className="en-linea"><input type="checkbox" checked={activo} onChange={(e) => cambiar(e.target.checked)} /> Recibir las alertas de {empresa.razon_social} en {usuario.email}</label>
      <Aviso msg={msg} />
      {activo && <div className="acciones izquierda"><button onClick={probar} disabled={enviando}>{enviando ? 'Enviando…' : 'Enviar correo de prueba'}</button></div>}
      {envios.length > 0 && <table className="tabla compacta"><tbody>{envios.map((e) => (
        <tr key={e.creado_en}><td>{new Date(e.creado_en).toLocaleString('es-CL')}</td><td>{{ enviado: 'Enviado', prueba: 'Prueba enviada', error: 'Error' }[e.estado]}</td><td className="chico">{e.error}</td></tr>))}</tbody></table>}
    </>
  );
}
