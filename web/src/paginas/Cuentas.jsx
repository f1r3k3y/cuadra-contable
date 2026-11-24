import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, sb } from '../supabase';
import { Aviso } from '../componentes';

const TIPOS = ['activo', 'pasivo', 'patrimonio', 'ingreso', 'gasto', 'orden'];
const CLASIF = {
  activo: ['activo_corriente', 'activo_no_corriente'],
  pasivo: ['pasivo_corriente', 'pasivo_no_corriente'],
  patrimonio: ['patrimonio'],
  ingreso: ['ingreso_operacional', 'ingreso_no_operacional'],
  gasto: ['costo_venta', 'gasto_operacional', 'gasto_no_operacional', 'impuesto_renta'],
  orden: ['orden'],
};
const bonito = (s) => (s ? s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()) : '');
const AUTOMATICAS = [
  ['cuenta_clientes', 'Clientes'], ['cuenta_proveedores', 'Proveedores'], ['cuenta_ventas', 'Ventas afectas'],
  ['cuenta_ventas_exentas', 'Ventas exentas'], ['cuenta_iva_debito', 'IVA débito fiscal'], ['cuenta_iva_credito', 'IVA crédito fiscal'],
  ['cuenta_iva_no_recuperable', 'IVA no recuperable'], ['cuenta_gasto_defecto', 'Gasto por defecto (compras)'],
];

export default function Cuentas() {
  const { empresa, permite } = useEmpresa();
  const [cuentas, setCuentas] = useState([]);
  const [conf, setConf] = useState(null);
  const [filtro, setFiltro] = useState('');
  const [nueva, setNueva] = useState(null);
  const [msg, setMsg] = useState(null);
  const escribe = permite('cuentas.gestionar');

  const cargar = useCallback(async () => {
    const [c, k] = await Promise.all([
      q(sb.from('cuentas').select('*').eq('empresa_id', empresa.id).order('codigo')),
      q(sb.from('configuracion_cuentas').select('*').eq('empresa_id', empresa.id).maybeSingle()),
    ]);
    setCuentas(c);
    setConf(k);
  }, [empresa.id]);
  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  async function crear(e) {
    e.preventDefault();
    setMsg(null);
    try {
      const padre = cuentas.find((c) => nueva.codigo.startsWith(c.codigo + '.') && nueva.codigo.split('.').length === c.codigo.split('.').length + 1);
      await q(sb.from('cuentas').insert({
        empresa_id: empresa.id, codigo: nueva.codigo.trim(), nombre: nueva.nombre.trim(), tipo: nueva.tipo,
        clasificacion: nueva.clasificacion || null, imputable: nueva.imputable, es_efectivo: nueva.es_efectivo,
        padre_id: padre?.id ?? null, nivel: nueva.codigo.split('.').length,
      }));
      setNueva(null);
      setMsg({ ok: true, t: 'Cuenta creada.' });
      cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function alternar(c) {
    try { await q(sb.from('cuentas').update({ activa: !c.activa }).eq('id', c.id)); cargar(); }
    catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function guardarConf(campo, valor) {
    try {
      await q(sb.from('configuracion_cuentas').upsert({ empresa_id: empresa.id, ...conf, [campo]: valor || null }));
      setConf({ ...conf, [campo]: valor || null });
      setMsg({ ok: true, t: 'Configuración guardada.' });
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  const imputables = cuentas.filter((c) => c.imputable && c.activa);
  const vista = cuentas.filter((c) => !filtro || (c.codigo + ' ' + c.nombre).toLowerCase().includes(filtro.toLowerCase()));

  return (
    <section className="hoja">
      <header className="cabecera">
        <div><h1>Plan de cuentas</h1><p className="chico">{cuentas.length} cuentas · solo las imputables reciben movimientos.</p></div>
        <div className="filtros">
          <input type="search" placeholder="Buscar código o nombre" value={filtro} onChange={(e) => setFiltro(e.target.value)} aria-label="Buscar cuenta" />
          {escribe && !nueva && <button className="primario" onClick={() => setNueva({ codigo: '', nombre: '', tipo: 'gasto', clasificacion: 'gasto_operacional', imputable: true, es_efectivo: false })}>+ Nueva cuenta</button>}
        </div>
      </header>
      <Aviso msg={msg} />

      {nueva && (
        <form className="formulario rejilla" onSubmit={crear}>
          <label>Código<input value={nueva.codigo} onChange={(e) => setNueva({ ...nueva, codigo: e.target.value })} pattern="\d+(\.\d+)*" placeholder="5.2.10" required /></label>
          <label className="ancho" data-ayuda="Nombre descriptivo de la cuenta (ej.: Banco Estado cuenta corriente, Arriendos).">Nombre<input value={nueva.nombre} onChange={(e) => setNueva({ ...nueva, nombre: e.target.value })} required maxLength={120} /></label>
          <label data-ayuda="Naturaleza de la cuenta: activo, pasivo, patrimonio, ingreso, gasto u orden. Define si es de balance o de resultado.">Tipo<select value={nueva.tipo} onChange={(e) => setNueva({ ...nueva, tipo: e.target.value, clasificacion: CLASIF[e.target.value][0] })}>
            {TIPOS.map((t) => <option key={t} value={t}>{bonito(t)}</option>)}</select></label>
          <label>Clasificación<select value={nueva.clasificacion} onChange={(e) => setNueva({ ...nueva, clasificacion: e.target.value })}>
            {CLASIF[nueva.tipo].map((t) => <option key={t} value={t}>{bonito(t)}</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={nueva.imputable} onChange={(e) => setNueva({ ...nueva, imputable: e.target.checked })} /> Imputable</label>
          <label className="check"><input type="checkbox" checked={nueva.es_efectivo} onChange={(e) => setNueva({ ...nueva, es_efectivo: e.target.checked })} /> Es caja o banco</label>
          <div className="acciones ancho"><button type="button" onClick={() => setNueva(null)}>Cancelar</button><button className="primario">Crear cuenta</button></div>
        </form>
      )}

      <div className="dos-columnas ancha-izq">
        <div className="scroll">
          <table className="tabla">
            <thead><tr><th>Código</th><th>Nombre</th><th>Tipo</th><th>Clasificación</th><th></th></tr></thead>
            <tbody>
              {vista.map((c) => (
                <tr key={c.id} className={!c.activa ? 'anulado' : c.imputable ? '' : 'titulo-cuenta'}>
                  <td className="nw">{c.codigo}</td>
                  <td style={{ paddingInlineStart: (c.nivel || 1) * 10 + 'px' }}>{c.nombre}{c.es_efectivo && <small> · efectivo</small>}</td>
                  <td>{bonito(c.tipo)}</td><td>{bonito(c.clasificacion)}</td>
                  <td>{escribe && c.imputable && <button className="enlace" onClick={() => alternar(c)}>{c.activa ? 'Desactivar' : 'Activar'}</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h2>Cuentas automáticas</h2>
          <p className="chico">Las usa el registro de compras y ventas para armar cada asiento.</p>
          {conf && AUTOMATICAS.map(([campo, nombre]) => (
            <label key={campo} className="bloque">{nombre}
              <select value={conf[campo] ?? ''} disabled={!escribe} onChange={(e) => guardarConf(campo, e.target.value)}>
                <option value="">Sin asignar</option>
                {imputables.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
              </select>
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
