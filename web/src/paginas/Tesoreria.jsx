import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { TIPOS_DOC, csv, hoy, peso, rutFormato } from '../util';

const MEDIOS = { transferencia: 'Transferencia', cheque: 'Cheque', efectivo: 'Efectivo', tarjeta: 'Tarjeta', deposito: 'Depósito', otro: 'Otro' };
const dias = (f) => Math.floor((new Date(hoy()) - new Date(f)) / 86400000);

export default function Tesoreria() {
  const { empresa, permite } = useEmpresa();
  const [vista, setVista] = useState('cobrar');
  const [res, setRes] = useState(null);
  const [docs, setDocs] = useState([]);
  const [movs, setMovs] = useState([]);
  const [dialogo, setDialogo] = useState(null);
  const [anular, setAnular] = useState(null);
  const [msg, setMsg] = useState(null);
  const registra = permite('tesoreria.registrar');
  const anula = permite('tesoreria.anular');

  const cargar = useCallback(async () => {
    setRes(await rpc('resumen_tesoreria', { p_empresa: empresa.id }));
    if (vista === 'movimientos') {
      setMovs(await q(sb.from('pagos').select('*, documentos(tipo, folio, razon_social), cuentas(codigo, nombre)').eq('empresa_id', empresa.id).order('fecha', { ascending: false }).limit(200)));
    } else {
      setDocs(await q(sb.from('documentos_saldo').select('*').eq('empresa_id', empresa.id)
        .eq('operacion', vista === 'cobrar' ? 'venta' : 'compra').eq('estado', 'vigente').neq('tipo', 61).gt('saldo', 0).order('fecha')));
    }
  }, [empresa.id, vista]);
  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  async function registrar(e) {
    e.preventDefault();
    try {
      await rpc('registrar_pago', { p_documento: dialogo.doc.id, p_fecha: dialogo.fecha, p_monto: Number(dialogo.monto), p_cuenta: dialogo.cuenta, p_medio: dialogo.medio, p_referencia: dialogo.referencia || null });
      setMsg({ ok: true, t: (vista === 'cobrar' ? 'Cobro' : 'Pago') + ' registrado y contabilizado.' });
      setDialogo(null);
      cargar();
    } catch (err) { setDialogo({ ...dialogo, error: err.message }); }
  }

  async function confirmarAnulacion(e) {
    e.preventDefault();
    try { await rpc('anular_pago', { p_id: anular.id, p_motivo: anular.motivo }); setAnular(null); setMsg({ ok: true, t: 'Movimiento anulado; el saldo del documento se restituyó.' }); cargar(); }
    catch (err) { setAnular({ ...anular, error: err.message }); }
  }

  if (!res) return <section className="hoja">{msg ? <p className="aviso error">{msg.t}</p> : <p>Cargando tesorería…</p>}</section>;
  const caja = res.cuentas.reduce((s, c) => s + Number(c.saldo), 0);
  const tramos = vista === 'pagar' ? res.porPagar : res.porCobrar;

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Caja y bancos {peso(caja)}</h1>
          <p className="chico">Por cobrar {peso(res.porCobrar.total)} · por pagar {peso(res.porPagar.total)} · solo documentos aprobados por contabilidad</p>
        </div>
        <div className="pestanas">
          <button className={vista === 'cobrar' ? 'activa' : ''} onClick={() => setVista('cobrar')}>Por cobrar</button>
          <button className={vista === 'pagar' ? 'activa' : ''} onClick={() => setVista('pagar')}>Por pagar</button>
          <button className={vista === 'movimientos' ? 'activa' : ''} onClick={() => setVista('movimientos')}>Movimientos</button>
        </div>
      </header>
      {msg && <p className={msg.ok ? 'aviso ok' : 'aviso error'}>{msg.t}</p>}

      <div className="dos-columnas">
        <div>
          <h2>Saldos por cuenta</h2>
          <table className="tabla"><tbody>
            {res.cuentas.map((c) => <tr key={c.id}><td>{c.codigo} {c.nombre}</td><td className="n">{peso(c.saldo)}</td></tr>)}
          </tbody></table>
        </div>
        {vista !== 'movimientos' && (
          <div>
            <h2>Antigüedad {vista === 'cobrar' ? 'de cuentas por cobrar' : 'de cuentas por pagar'}</h2>
            <div className="tramos">
              <div><span>0 a 30 días</span><b>{peso(tramos.a30)}</b></div>
              <div><span>31 a 60</span><b>{peso(tramos.a60)}</b></div>
              <div className="vencido"><span>61 a 90</span><b>{peso(tramos.a90)}</b></div>
              <div className="vencido"><span>Más de 90</span><b>{peso(tramos.mas90)}</b></div>
            </div>
          </div>
        )}
      </div>

      {vista !== 'movimientos' ? (
        <>
          <h2>{vista === 'cobrar' ? 'Documentos por cobrar' : 'Documentos por pagar'}</h2>
          <div className="scroll">
            <table className="tabla">
              <thead><tr><th>Fecha</th><th className="n">Días</th><th>Documento</th><th>{vista === 'cobrar' ? 'Cliente' : 'Proveedor'}</th><th className="n">Total</th><th className="n">Saldo</th><th></th></tr></thead>
              <tbody>
                {docs.length === 0 && <tr><td colSpan={7} className="vacio">No hay saldos pendientes.</td></tr>}
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td className="nw">{d.fecha}</td><td className={'n' + (dias(d.fecha) > 60 ? ' error-texto' : '')}>{dias(d.fecha)}</td>
                    <td title={TIPOS_DOC[d.tipo]}>{d.tipo} N° {d.folio}{d.asiento_estado !== 'contabilizado' && <small> · por aprobar</small>}</td>
                    <td>{d.razon_social}<small> · {rutFormato(d.rut)}</small></td>
                    <td className="n">{peso(d.total)}</td><td className="n">{peso(d.saldo)}</td>
                    <td>{registra && d.asiento_estado === 'contabilizado' && (
                      <button className="enlace" onClick={() => setDialogo({ doc: d, fecha: hoy(), monto: d.saldo, cuenta: res.cuentas[0]?.id ?? '', medio: 'transferencia', referencia: '' })}>
                        {vista === 'cobrar' ? 'Registrar cobro' : 'Registrar pago'}
                      </button>)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <h2>Cobros y pagos registrados</h2>
          <div className="scroll">
            <table className="tabla">
              <thead><tr><th>Fecha</th><th data-ayuda="Cobro: dinero recibido de un cliente. Pago: dinero entregado a un proveedor.">Tipo</th><th>Documento</th><th>Cuenta</th><th>Medio</th><th className="n">Monto</th><th></th></tr></thead>
              <tbody>
                {movs.length === 0 && <tr><td colSpan={7} className="vacio">Aún no hay movimientos.</td></tr>}
                {movs.map((m) => (
                  <tr key={m.id} className={m.estado === 'anulado' ? 'anulado' : ''}>
                    <td className="nw">{m.fecha}</td><td>{m.tipo === 'cobro' ? 'Cobro' : 'Pago'}</td>
                    <td>{m.documentos.tipo} N° {m.documentos.folio} · {m.documentos.razon_social}</td>
                    <td>{m.cuentas.nombre}</td><td>{MEDIOS[m.medio]}{m.referencia && <small> · {m.referencia}</small>}</td>
                    <td className="n">{peso(m.monto)}</td>
                    <td>{m.estado === 'anulado' ? <span className="etiqueta anulado" title={m.motivo_anulacion}>Anulado</span>
                      : anula && <button className="enlace" onClick={() => setAnular({ id: m.id, motivo: '' })}>Anular</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {movs.length > 0 && <button onClick={() => csv('movimientos_tesoreria', movs.map((m) => ({ Fecha: m.fecha, Tipo: m.tipo, Documento: `${m.documentos.tipo}-${m.documentos.folio}`, Contraparte: m.documentos.razon_social, Cuenta: m.cuentas.nombre, Medio: m.medio, Referencia: m.referencia, Monto: m.monto, Estado: m.estado })))}>Descargar CSV</button>}
        </>
      )}

      {dialogo && (
        <div className="velo" role="dialog" aria-modal="true">
          <form className="dialogo" onSubmit={registrar}>
            <h2>{vista === 'cobrar' ? 'Registrar cobro' : 'Registrar pago'}</h2>
            <p className="chico">{dialogo.doc.tipo} N° {dialogo.doc.folio} · {dialogo.doc.razon_social} · saldo {peso(dialogo.doc.saldo)}</p>
            <label>Fecha<input type="date" min={dialogo.doc.fecha} max={hoy()} value={dialogo.fecha} onChange={(e) => setDialogo({ ...dialogo, fecha: e.target.value })} required /></label>
            <label>Monto<input type="number" min="1" max={dialogo.doc.saldo} step="1" value={dialogo.monto} onChange={(e) => setDialogo({ ...dialogo, monto: e.target.value })} required /></label>
            <label>Cuenta de caja o banco<select value={dialogo.cuenta} onChange={(e) => setDialogo({ ...dialogo, cuenta: e.target.value })} required>
              {res.cuentas.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
            </select></label>
            <label>Medio<select value={dialogo.medio} onChange={(e) => setDialogo({ ...dialogo, medio: e.target.value })}>
              {Object.entries(MEDIOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select></label>
            <label>Referencia (N° de transferencia o cheque)<input value={dialogo.referencia} onChange={(e) => setDialogo({ ...dialogo, referencia: e.target.value })} maxLength={100} /></label>
            {dialogo.error && <p className="aviso error">{dialogo.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setDialogo(null)}>Cancelar</button><button className="primario">Registrar</button></div>
          </form>
        </div>
      )}

      {anular && (
        <div className="velo" role="dialog" aria-modal="true">
          <form className="dialogo" onSubmit={confirmarAnulacion}>
            <h2>Anular movimiento</h2>
            <p>Se anula (o reversa) su asiento y el documento vuelve a quedar con saldo.</p>
            <label>Motivo<input value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} minLength={5} required autoFocus /></label>
            {anular.error && <p className="aviso error">{anular.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAnular(null)}>Cancelar</button><button className="peligro">Anular</button></div>
          </form>
        </div>
      )}
    </section>
  );
}
