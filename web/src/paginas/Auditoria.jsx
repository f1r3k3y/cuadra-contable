import { useCallback, useEffect, useMemo, useState } from 'react';
import { useEmpresa } from '../App';
import { rpc } from '../supabase';
import { ROLES, TIPOS_DOC, csv, hoy, peso } from '../util';
import { Dialogo, filaAccionable } from '../componentes';

const MODULOS = {
  accesos: 'Accesos', empresas: 'Empresa', miembros: 'Usuarios y roles', invitaciones: 'Invitaciones', documentos: 'Compras y ventas', pagos: 'Tesorería',
  asientos: 'Asientos', asiento_lineas: 'Líneas de asiento', cuentas: 'Plan de cuentas', configuracion_cuentas: 'Cuentas automáticas',
  periodos: 'Períodos', f29_declaraciones: 'F29', auxiliares: 'Clientes y proveedores', centros_costo: 'Centros de costo',
  dte_emitidos: 'DTE emitidos', dte_recibidos: 'DTE recibidos', certificados: 'Certificados', cafs: 'Folios (CAF)',
};
const ACCIONES = { INSERT: 'Creación', UPDATE: 'Modificación', DELETE: 'Eliminación' };
const PAGINA = 100;
const OCULTOS = new Set(['id', 'empresa_id']);

const fechaHora = (t) => new Date(t).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const masDias = (f, n) => { const d = new Date(f + 'T00:00:00'); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const bonito = (k) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const valor = (v) => (v == null ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));

// Traduce un registro de auditoría a una frase entendible
function describir(r) {
  const a = r.antes || {}, d = r.despues || {}, x = r.accion === 'DELETE' ? a : d;
  const cambio = (k) => r.accion === 'UPDATE' && a[k] !== d[k];
  const doc = (o) => `${TIPOS_DOC[o.tipo] ?? 'Doc. ' + o.tipo} N° ${o.folio}`;
  switch (r.tabla) {
    case 'accesos': return d.evento === 'salida' ? 'Cerró sesión' : `Ingresó a la empresa${d.rol ? ' como ' + (ROLES[d.rol] ?? d.rol) : ''}`;
    case 'documentos':
      if (r.accion === 'INSERT') return `Registró ${d.operacion} ${doc(d)} de ${d.razon_social} por ${peso(d.total)}`;
      if (cambio('estado') && d.estado === 'anulado') return `Anuló ${d.operacion} ${doc(d)}: ${d.motivo_anulacion ?? ''}`;
      return `Actualizó ${doc(x)} (vínculo contable)`;
    case 'pagos':
      if (r.accion === 'INSERT') return `Registró ${d.tipo} por ${peso(d.monto)} (${d.medio}${d.referencia ? ' ' + d.referencia : ''})`;
      if (cambio('estado') && d.estado === 'anulado') return `Anuló ${d.tipo} por ${peso(d.monto)}: ${d.motivo_anulacion ?? ''}`;
      return `Actualizó ${x.tipo} (vínculo contable)`;
    case 'asientos':
      if (r.accion === 'INSERT') return `Creó asiento en borrador: ${d.glosa}`;
      if (r.accion === 'DELETE') return `Eliminó asiento en borrador: ${a.glosa}`;
      if (cambio('estado') && d.estado === 'contabilizado') return `Aprobó y contabilizó asiento N° ${d.numero}: ${d.glosa}`;
      if (cambio('estado') && d.estado === 'anulado') return `Anuló asiento N° ${d.numero}: ${d.motivo_anulacion ?? ''}`;
      return `Modificó asiento ${d.numero ? 'N° ' + d.numero : 'en borrador'}`;
    case 'asiento_lineas':
      return `${ACCIONES[r.accion]} de línea ${x.linea}: debe ${peso(x.debe)} / haber ${peso(x.haber)}`;
    case 'miembros':
      if (r.accion === 'INSERT') return `Agregó un usuario con rol ${ROLES[d.rol] ?? d.rol}`;
      if (r.accion === 'DELETE') return `Quitó un usuario (rol ${ROLES[a.rol] ?? a.rol})`;
      if (cambio('rol')) return `Cambió rol de ${ROLES[a.rol] ?? a.rol} a ${ROLES[d.rol] ?? d.rol}`;
      if (cambio('rol_prueba')) return d.rol_prueba ? `Activó "ver la app como" ${ROLES[d.rol_prueba] ?? d.rol_prueba}` : 'Volvió a su rol real (Administrador)';
      return 'Modificó un usuario';
    case 'invitaciones':
      if (r.accion === 'INSERT') return `Invitó a ${d.correo} como ${ROLES[d.rol] ?? d.rol}`;
      if (cambio('estado') && d.estado === 'aceptada') return `${d.correo} aceptó la invitación (${ROLES[d.rol] ?? d.rol})`;
      if (cambio('estado') && d.estado === 'revocada') return `Revocó la invitación a ${d.correo}`;
      return `Modificó la invitación a ${x.correo}`;
    case 'periodos':
      if (r.accion === 'INSERT') return `Abrió el período ${d.mes}/${d.anio}`;
      if (cambio('estado')) return `${d.estado === 'cerrado' ? 'Cerró' : 'Reabrió'} el período ${d.mes}/${d.anio}`;
      return `Modificó el período ${x.mes}/${x.anio}`;
    case 'cuentas':
      if (r.accion === 'INSERT') return `Creó la cuenta ${d.codigo} ${d.nombre}`;
      if (cambio('activa')) return `${d.activa ? 'Activó' : 'Desactivó'} la cuenta ${d.codigo} ${d.nombre}`;
      return `${ACCIONES[r.accion]} de la cuenta ${x.codigo} ${x.nombre}`;
    case 'empresas':
      if (r.accion === 'INSERT') return `Creó la empresa ${d.razon_social}`;
      return `Modificó datos de la empresa: ${Object.keys(d).filter((k) => a[k] !== d[k] && JSON.stringify(a[k]) !== JSON.stringify(d[k])).map(bonito).join(', ')}`;
    case 'f29_declaraciones':
      if (r.accion === 'INSERT') return `Guardó la propuesta F29 de ${d.periodo} (total ${peso(d.total_pagar)})`;
      if (cambio('estado') && d.estado === 'presentado') return `Marcó el F29 de ${d.periodo} como presentado${d.folio_sii ? ' (folio ' + d.folio_sii + ')' : ''}`;
      return `${ACCIONES[r.accion]} de propuesta F29 ${x.periodo}`;
    case 'configuracion_cuentas': return 'Cambió las cuentas automáticas';
    case 'auxiliares': return `${ACCIONES[r.accion]} de ${x.razon_social} (${x.rut})`;
    default: return `${ACCIONES[r.accion] ?? r.accion} en ${MODULOS[r.tabla] ?? r.tabla}`;
  }
}

export default function Auditoria() {
  const { empresa } = useEmpresa();
  const [f, setF] = useState({ desde: masDias(hoy(), -30), hasta: hoy(), usuario: '', tabla: '', accion: '', texto: '' });
  const [buscar, setBuscar] = useState(f);
  const [pagina, setPagina] = useState(0);
  const [filas, setFilas] = useState(null);
  const [usuarios, setUsuarios] = useState([]);
  const [detalle, setDetalle] = useState(null);
  const [todos, setTodos] = useState(false);
  const [cadena, setCadena] = useState(null);
  const [error, setError] = useState(null);

  const args = useCallback((b, limite, offset) => ({
    p_empresa: empresa.id,
    p_desde: b.desde ? new Date(b.desde + 'T00:00:00').toISOString() : null,
    p_hasta: b.hasta ? new Date(masDias(b.hasta, 1) + 'T00:00:00').toISOString() : null,
    p_usuario: b.usuario || null, p_tabla: b.tabla || null, p_accion: b.accion || null, p_texto: b.texto.trim() || null,
    p_limite: limite, p_offset: offset,
  }), [empresa.id]);

  useEffect(() => {
    setFilas(null);
    setError(null);
    rpc('auditoria_consulta', args(buscar, PAGINA, pagina * PAGINA)).then(setFilas).catch((e) => setError(e.message));
  }, [args, buscar, pagina]);
  useEffect(() => { rpc('auditoria_usuarios', { p_empresa: empresa.id }).then(setUsuarios).catch(() => {}); }, [empresa.id]);

  const total = filas?.[0]?.total ?? 0;
  const aplicar = (nuevo) => { setF(nuevo); setBuscar(nuevo); setPagina(0); };
  const rango = (n) => aplicar({ ...f, desde: n == null ? '' : masDias(hoy(), -n), hasta: n == null ? '' : hoy() });
  const nombre = (r) => (r.usuario_id ? r.usuario_nombre || r.usuario_correo || r.usuario_id.slice(0, 8) : 'Sistema');

  async function verificar() {
    setCadena({ t: 'Verificando…' });
    try {
      const r = await rpc('verificar_auditoria', { p_empresa: empresa.id });
      setCadena(r == null ? { ok: true, t: 'Cadena íntegra: ningún registro fue alterado ni eliminado.' } : { ok: false, t: `Inconsistencia detectada en el registro N° ${r}: la bitácora fue alterada a partir de ahí.` });
    } catch (e) { setCadena({ ok: false, t: e.message }); }
  }

  async function exportar() {
    const todas = await rpc('auditoria_consulta', args(buscar, 5000, 0));
    csv(`auditoria_${empresa.rut}_${hoy()}`, todas.map((r) => ({
      'N°': r.id, 'Fecha y hora': fechaHora(r.en), Usuario: nombre(r), Correo: r.usuario_correo ?? '', IP: r.ip ?? '', País: r.pais ?? '', Navegador: r.agente ?? '',
      Módulo: MODULOS[r.tabla] ?? r.tabla, Acción: ACCIONES[r.accion] ?? r.accion, Descripción: describir(r),
      'Registro ID': r.registro_id ?? '', Antes: r.antes ? JSON.stringify(r.antes) : '', Después: r.despues ? JSON.stringify(r.despues) : '', Hash: r.hash,
    })));
  }

  const campos = useMemo(() => {
    if (!detalle) return [];
    const a = detalle.antes || {}, d = detalle.despues || {};
    return [...new Set([...Object.keys(a), ...Object.keys(d)])].filter((k) => !OCULTOS.has(k)).map((k) => ({
      k, antes: a[k], despues: d[k], cambio: detalle.accion === 'UPDATE' && JSON.stringify(a[k]) !== JSON.stringify(d[k]),
    })).filter((c) => todos || detalle.accion !== 'UPDATE' || c.cambio);
  }, [detalle, todos]);

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Auditoría {filas ? `· ${total.toLocaleString('es-CL')} ${total === 1 ? 'cambio' : 'cambios'}` : ''}</h1>
          <p className="chico">Cada creación, modificación, eliminación e ingreso queda registrado con usuario, fecha, hora, IP y los valores antes y después. La bitácora no se puede editar ni borrar.</p>
        </div>
        <div className="filtros">
          <button onClick={verificar}>Verificar integridad</button>
          <button onClick={exportar} disabled={!total}>Exportar CSV</button>
        </div>
      </header>
      {cadena && <p className={'aviso ' + (cadena.ok ? 'ok' : cadena.ok === false ? 'error' : '')}>{cadena.t}</p>}

      <form className="formulario rejilla" onSubmit={(e) => { e.preventDefault(); aplicar(f); }}>
        <label>Desde<input type="date" value={f.desde} onChange={(e) => setF({ ...f, desde: e.target.value })} /></label>
        <label>Hasta<input type="date" value={f.hasta} onChange={(e) => setF({ ...f, hasta: e.target.value })} /></label>
        <label>Usuario<select value={f.usuario} onChange={(e) => aplicar({ ...f, usuario: e.target.value })}>
          <option value="">Todos</option>
          {usuarios.filter((u) => u.usuario_id).map((u) => <option key={u.usuario_id} value={u.usuario_id}>{u.nombre || u.correo} ({u.correo})</option>)}
        </select></label>
        <label>Módulo<select value={f.tabla} onChange={(e) => aplicar({ ...f, tabla: e.target.value })}>
          <option value="">Todos</option>
          {Object.entries(MODULOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>Acción<select value={f.accion} onChange={(e) => aplicar({ ...f, accion: e.target.value })}>
          <option value="">Todas</option>
          {Object.entries(ACCIONES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select></label>
        <label>Buscar en el contenido<input type="search" value={f.texto} onChange={(e) => setF({ ...f, texto: e.target.value })} placeholder="Folio, RUT, glosa, motivo…" /></label>
        <div className="acciones ancho">
          <span className="chico">Rango rápido:</span>
          <button type="button" onClick={() => rango(0)}>Hoy</button>
          <button type="button" onClick={() => rango(7)}>7 días</button>
          <button type="button" onClick={() => rango(30)}>30 días</button>
          <button type="button" onClick={() => rango(null)}>Todo</button>
          <button className="primario">Buscar</button>
        </div>
      </form>

      {error && <p className="aviso error">{error}</p>}
      <div className="scroll">
        <table className="tabla">
          <thead><tr><th className="n">N°</th><th>Fecha y hora</th><th>Usuario</th><th>Módulo</th><th>Qué hizo</th><th>IP</th><th></th></tr></thead>
          <tbody>
            {!filas && !error && <tr><td colSpan={7}>Cargando…</td></tr>}
            {filas?.length === 0 && <tr><td colSpan={7} className="vacio">No hay cambios con esos filtros.</td></tr>}
            {filas?.map((r) => (
              <tr key={r.id} className="clic" {...filaAccionable(() => { setDetalle(r); setTodos(false); }, 'Ver detalle del cambio')}>
                <td className="n">{r.id}</td>
                <td className="nw">{fechaHora(r.en)}</td>
                <td>{nombre(r)}{r.usuario_correo && <small><br />{r.usuario_correo}</small>}</td>
                <td><span className={'etiqueta ' + (r.accion === 'DELETE' ? 'anulado' : r.accion === 'INSERT' ? 'contabilizado' : 'borrador')}>{MODULOS[r.tabla] ?? r.tabla}</span></td>
                <td>{describir(r)}</td>
                <td className="nw">{r.ip ?? '—'}</td>
                <td><button className="enlace">Detalle</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > PAGINA && (
        <div className="acciones izq">
          <button disabled={pagina === 0} onClick={() => setPagina(pagina - 1)}>Anterior</button>
          <span className="chico">Mostrando {pagina * PAGINA + 1}–{Math.min((pagina + 1) * PAGINA, total)} de {total.toLocaleString('es-CL')}</span>
          <button disabled={(pagina + 1) * PAGINA >= total} onClick={() => setPagina(pagina + 1)}>Siguiente</button>
        </div>
      )}

      <h2>Actividad por usuario</h2>
      <div className="scroll">
        <table className="tabla compacta">
          <thead><tr><th>Usuario</th><th>Correo</th><th className="n">Cambios</th><th>Última actividad</th><th></th></tr></thead>
          <tbody>{usuarios.map((u) => (
            <tr key={u.usuario_id ?? 'sistema'}>
              <td>{u.usuario_id ? u.nombre || '—' : 'Sistema'}</td><td>{u.correo ?? ''}</td><td className="n">{Number(u.cambios).toLocaleString('es-CL')}</td>
              <td className="nw">{fechaHora(u.ultimo)}</td>
              <td>{u.usuario_id && <button className="enlace" onClick={() => aplicar({ ...f, usuario: u.usuario_id, desde: '', hasta: '' })}>Ver sus cambios</button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </div>

      {detalle && (
        <Dialogo titulo={`Registro N° ${detalle.id}`} ancho alCerrar={() => setDetalle(null)}>
          <div>
            <h2>Registro N° {detalle.id}</h2>
            <p>{describir(detalle)}</p>
            <dl className="ficha">
              <dt>Fecha y hora</dt><dd>{fechaHora(detalle.en)}</dd>
              <dt>Usuario</dt><dd>{nombre(detalle)}{detalle.usuario_correo ? ` · ${detalle.usuario_correo}` : ''}</dd>
              <dt>IP</dt><dd>{detalle.ip ?? '—'}{detalle.pais ? ` (${detalle.pais})` : ''}</dd>
              <dt>Navegador</dt><dd>{detalle.agente ?? '—'}</dd>
              <dt>Módulo</dt><dd>{MODULOS[detalle.tabla] ?? detalle.tabla} ({detalle.tabla})</dd>
              <dt>Acción</dt><dd>{ACCIONES[detalle.accion] ?? detalle.accion}</dd>
              <dt>ID del registro</dt><dd><code>{detalle.registro_id ?? '—'}</code></dd>
              <dt>Hash</dt><dd><code>{detalle.hash}</code></dd>
              <dt>Hash anterior</dt><dd><code>{detalle.hash_anterior ?? '— (primer registro)'}</code></dd>
            </dl>
            <div className="acciones izq">
              <b>{detalle.accion === 'UPDATE' ? 'Campos modificados' : detalle.accion === 'INSERT' ? 'Valores creados' : 'Valores eliminados'}</b>
              {detalle.accion === 'UPDATE' && <label className="check"><input type="checkbox" checked={todos} onChange={(e) => setTodos(e.target.checked)} /> Mostrar todos los campos</label>}
            </div>
            <div className="scroll detalle-campos">
              <table className="tabla compacta">
                <thead><tr><th>Campo</th>{detalle.accion !== 'INSERT' && <th>Antes</th>}{detalle.accion !== 'DELETE' && <th>Después</th>}</tr></thead>
                <tbody>{campos.map((c) => (
                  <tr key={c.k} className={c.cambio ? 'cambiado' : ''}>
                    <td>{bonito(c.k)}</td>
                    {detalle.accion !== 'INSERT' && <td><code>{valor(c.antes)}</code></td>}
                    {detalle.accion !== 'DELETE' && <td><code>{valor(c.despues)}</code></td>}
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <div className="acciones"><button className="primario" onClick={() => setDetalle(null)}>Cerrar</button></div>
          </div>
        </Dialogo>
      )}
    </section>
  );
}
