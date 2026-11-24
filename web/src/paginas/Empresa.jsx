import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { MESES, ROLES, rutFormato } from '../util';

export default function Empresa() {
  const { empresa, puede, usuario, recargarEmpresas } = useEmpresa();
  const [datos, setDatos] = useState(null);
  const [miembros, setMiembros] = useState([]);
  const [periodos, setPeriodos] = useState([]);
  const [auditoria, setAuditoria] = useState(null);
  const [cadena, setCadena] = useState(null);
  const [invitar, setInvitar] = useState({ correo: '', rol: 'contador' });
  const [msg, setMsg] = useState(null);
  const admin = puede('admin');
  const contador = puede('admin', 'contador');
  const audita = puede('admin', 'auditor');

  const cargar = useCallback(async () => {
    const [d, m, p] = await Promise.all([
      q(sb.from('empresas').select('*').eq('id', empresa.id).single()),
      q(sb.from('miembros').select('user_id, rol, creado_en, perfiles(nombre)').eq('empresa_id', empresa.id)),
      q(sb.from('periodos').select('*').eq('empresa_id', empresa.id).order('anio', { ascending: false }).order('mes', { ascending: false })),
    ]);
    setDatos(d); setMiembros(m); setPeriodos(p);
    if (audita) setAuditoria(await q(sb.from('auditoria').select('id, tabla, accion, en, usuario_id, ip').eq('empresa_id', empresa.id).order('id', { ascending: false }).limit(40)));
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
  const nombreDe = (id) => miembros.find((m) => m.user_id === id)?.perfiles?.nombre ?? (id ? id.slice(0, 8) : 'sistema');

  if (!datos) return <section className="hoja">{msg ? <p className="aviso error">{msg.t}</p> : <p>Cargando…</p>}</section>;

  return (
    <section className="hoja">
      <header className="cabecera"><div><h1>{datos.razon_social}</h1><p className="chico">RUT {rutFormato(datos.rut)}</p></div></header>
      {msg && <p className={msg.ok ? 'aviso ok' : 'aviso error'}>{msg.t}</p>}

      <div className="dos-columnas">
        <form className="formulario" onSubmit={guardarDatos}>
          <h2>Datos de la empresa</h2>
          <fieldset disabled={!admin}>
            <label>Razón social<input value={datos.razon_social} onChange={set('razon_social')} required /></label>
            <label>Nombre de fantasía<input value={datos.nombre_fantasia ?? ''} onChange={set('nombre_fantasia')} /></label>
            <label>Giro<input value={datos.giro} onChange={set('giro')} required /></label>
            <label>Dirección<input value={datos.direccion} onChange={set('direccion')} /></label>
            <label>Comuna<input value={datos.comuna} onChange={set('comuna')} /></label>
            <label>Correo<input type="email" value={datos.correo ?? ''} onChange={set('correo')} /></label>
            <label>Tasa PPM (%)<input type="number" step="0.001" min="0" max="10" value={datos.tasa_ppm} onChange={set('tasa_ppm')} /></label>
            <label>Remanente de crédito fiscal inicial ($)<input type="number" min="0" step="1" value={datos.remanente_inicial} onChange={set('remanente_inicial')} /></label>
            {admin && <div className="acciones"><button className="primario">Guardar datos</button></div>}
          </fieldset>
        </form>

        <div>
          <h2>Usuarios y roles</h2>
          <table className="tabla"><tbody>
            {miembros.map((m) => (
              <tr key={m.user_id}>
                <td>{m.perfiles?.nombre ?? '—'}{m.user_id === usuario.id && <small> · tú</small>}</td>
                <td>{admin && m.user_id !== usuario.id ? (
                  <select value={m.rol} aria-label="Rol" onChange={(e) => hacer(() => q(sb.from('miembros').update({ rol: e.target.value }).eq('empresa_id', empresa.id).eq('user_id', m.user_id)), 'Rol actualizado.')()}>
                    {Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>) : ROLES[m.rol]}</td>
                <td>{admin && m.user_id !== usuario.id && <button className="enlace" onClick={hacer(() => q(sb.from('miembros').delete().eq('empresa_id', empresa.id).eq('user_id', m.user_id)), 'Usuario quitado de la empresa.')}>Quitar</button>}</td>
              </tr>
            ))}
          </tbody></table>
          {admin && (
            <form className="formulario en-fila" onSubmit={hacer(async () => { await rpc('agregar_miembro', { p_empresa: empresa.id, p_correo: invitar.correo, p_rol: invitar.rol }); setInvitar({ ...invitar, correo: '' }); }, 'Usuario agregado.')}>
              <label>Correo del usuario<input type="email" value={invitar.correo} onChange={(e) => setInvitar({ ...invitar, correo: e.target.value })} required /></label>
              <label>Rol<select value={invitar.rol} onChange={(e) => setInvitar({ ...invitar, rol: e.target.value })}>{Object.entries(ROLES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
              <button className="primario">Agregar</button>
            </form>
          )}
          <p className="chico">La persona debe haber creado su cuenta antes. Contador registra y contabiliza; operador solo deja borradores; auditor y lector solo consultan.</p>

          <h2>Períodos contables</h2>
          <p className="chico">Un mes cerrado no acepta asientos nuevos ni anulaciones.</p>
          <table className="tabla"><tbody>
            {periodos.map((p) => (
              <tr key={p.anio * 100 + p.mes}>
                <td>{MESES[p.mes - 1]} {p.anio}</td><td><span className={'etiqueta ' + (p.estado === 'cerrado' ? 'anulado' : 'contabilizado')}>{p.estado}</span></td>
                <td>{contador && (p.estado === 'abierto'
                  ? <button className="enlace" onClick={hacer(() => rpc('cerrar_periodo', { p_empresa: empresa.id, p_anio: p.anio, p_mes: p.mes }), 'Período cerrado.')}>Cerrar</button>
                  : admin && <button className="enlace" onClick={hacer(() => rpc('reabrir_periodo', { p_empresa: empresa.id, p_anio: p.anio, p_mes: p.mes }), 'Período reabierto.')}>Reabrir</button>)}</td>
              </tr>
            ))}
          </tbody></table>
        </div>
      </div>

      {audita && auditoria && (
        <>
          <h2>Auditoría</h2>
          <p className="chico">Cada cambio queda encadenado con un hash SHA-256; si alguien altera un registro, la verificación lo detecta.</p>
          <div className="acciones izq">
            <button onClick={async () => { try { const r = await rpc('verificar_auditoria', { p_empresa: empresa.id }); setCadena(r == null ? { ok: true, t: 'Cadena íntegra: ningún registro fue alterado.' } : { ok: false, t: 'Inconsistencia en el registro N° ' + r }); } catch (e) { setCadena({ ok: false, t: e.message }); } }}>Verificar integridad</button>
            {cadena && <span className={cadena.ok ? 'ok-texto' : 'error-texto'}>{cadena.t}</span>}
          </div>
          <div className="scroll">
            <table className="tabla compacta"><thead><tr><th className="n">N°</th><th>Fecha</th><th>Tabla</th><th>Acción</th><th>Usuario</th><th>IP</th></tr></thead>
              <tbody>{auditoria.map((a) => (
                <tr key={a.id}><td className="n">{a.id}</td><td className="nw">{new Date(a.en).toLocaleString('es-CL')}</td><td>{a.tabla}</td><td>{a.accion}</td><td>{nombreDe(a.usuario_id)}</td><td>{a.ip ?? ''}</td></tr>
              ))}</tbody></table>
          </div>
        </>
      )}
    </section>
  );
}
