import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { csv, fecha, hoy, MESES_LARGOS, peso } from '../util';
import { Aviso, CampoMonto, Dialogo, SelectorMes } from '../componentes';

// Tabla de vida útil del SII (Res. Ex. N° 43 de 2002, activos genéricos): [nombre, años normal, años acelerada, cuenta sugerida]
export const VIDA_UTIL_SII = [
  ['Computadores, sistemas computacionales y periféricos', 6, 2, '1.2.01.01'],
  ['Muebles y enseres', 7, 2, '1.2.01.02'],
  ['Útiles de oficina (fotocopiadoras, impresoras, etc.)', 3, 1, '1.2.01.02'],
  ['Automóviles, camionetas y jeeps', 7, 2, '1.2.01.03'],
  ['Camiones de uso general', 7, 2, '1.2.01.03'],
  ['Motos en general', 7, 2, '1.2.01.03'],
  ['Maquinarias y equipos en general', 15, 5, null],
  ['Herramientas pesadas', 8, 2, null],
  ['Herramientas livianas', 3, 1, null],
  ['Instalaciones en general (eléctricas, de oficina)', 10, 3, null],
  ['Equipos de aire y cámaras de refrigeración', 10, 3, null],
  ['Balanzas, refrigeradores, vitrinas refrigeradas y cocinas', 9, 3, null],
  ['Equipos de audio y video', 6, 2, null],
  ['Equipos de vigilancia y alarmas', 7, 2, null],
  ['Equipos médicos en general', 8, 2, null],
  ['Letreros camineros y luminosos', 10, 3, null],
  ['Galpones de madera o estructura metálica', 20, 6, null],
  ['Edificios de ladrillo u hormigón', 50, 16, null],
];

const vacio = () => ({ nombre: '', codigo: '', categoria: 0, regimen: 'normal', meses: String(VIDA_UTIL_SII[0][1] * 12), fecha: hoy(), inicio: hoy().slice(0, 7),
  valor: '', residual: '1', inicial: '', cuentaActivo: '', cuentaDep: '', cuentaGasto: '', documento: '' });

export default function ActivoFijo() {
  const { empresa, permite } = useEmpresa();
  const gestiona = permite('activos.gestionar');
  const [activos, setActivos] = useState(null);
  const [deps, setDeps] = useState([]);
  const [cuentas, setCuentas] = useState([]);
  const [compras, setCompras] = useState([]);
  const [mes, setMes] = useState(hoy().slice(0, 7));
  const [f, setF] = useState(null);
  const [baja, setBaja] = useState(null);
  const [anular, setAnular] = useState(null);
  const [ver, setVer] = useState('activos');
  const [msg, setMsg] = useState(null);

  const cargar = useCallback(async () => {
    const [a, d] = await Promise.all([
      q(sb.from('activos_saldo').select('*').eq('empresa_id', empresa.id).order('estado').order('nombre')),
      q(sb.from('depreciaciones').select('periodo, monto, asiento_id, asientos(numero, estado)').eq('empresa_id', empresa.id).order('periodo', { ascending: false }).limit(2000)),
    ]);
    setActivos(a);
    const porMes = {};
    for (const x of d) {
      if (x.asientos?.estado === 'anulado') continue;
      const m = (porMes[x.periodo] ??= { periodo: x.periodo, total: 0, activos: 0, numero: x.asientos?.numero, estado: x.asientos?.estado });
      m.total += Number(x.monto); m.activos += 1;
    }
    setDeps(Object.values(porMes).sort((x, y) => y.periodo.localeCompare(x.periodo)));
  }, [empresa.id]);
  useEffect(() => { cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  useEffect(() => {
    if (!gestiona) return;
    q(sb.from('cuentas').select('id, codigo, nombre, tipo').eq('empresa_id', empresa.id).eq('imputable', true).eq('activa', true).order('codigo')).then(setCuentas).catch(() => {});
    q(sb.from('documentos').select('id, tipo, folio, fecha, razon_social, neto').eq('empresa_id', empresa.id).eq('operacion', 'compra').eq('estado', 'vigente')
      .order('fecha', { ascending: false }).limit(100)).then(setCompras).catch(() => {});
  }, [empresa.id, gestiona]);

  const porCodigo = (c) => cuentas.find((x) => x.codigo === c)?.id ?? '';
  function nuevo() {
    const v = vacio();
    setF({ ...v, cuentaActivo: porCodigo(VIDA_UTIL_SII[0][3]), cuentaDep: porCodigo('1.2.01.90'), cuentaGasto: porCodigo('5.2.08') });
  }
  function elegirCategoria(i, regimen = f.regimen) {
    const [, n, a, cta] = VIDA_UTIL_SII[i];
    setF({ ...f, categoria: i, regimen, meses: String((regimen === 'acelerada' ? a : n) * 12), cuentaActivo: cta ? porCodigo(cta) || f.cuentaActivo : f.cuentaActivo });
  }

  async function guardar(e) {
    e.preventDefault();
    try {
      await rpc('registrar_activo', {
        p_empresa: empresa.id, p_nombre: f.nombre, p_fecha_compra: f.fecha, p_valor: Number(f.valor), p_vida_util_meses: Number(f.meses),
        p_cuenta_activo: f.cuentaActivo, p_cuenta_depreciacion: f.cuentaDep, p_cuenta_gasto: f.cuentaGasto,
        p_inicio: f.inicio + '-01', p_valor_residual: Number(f.residual || 0), p_depreciacion_inicial: Number(f.inicial || 0),
        p_categoria: VIDA_UTIL_SII[f.categoria][0] + (f.regimen === 'acelerada' ? ' (acelerada)' : ''), p_codigo: f.codigo || null, p_documento: f.documento || null,
      });
      setF(null); setMsg({ ok: true, t: 'Activo registrado. Se depreciará desde ' + MESES_LARGOS[Number(f.inicio.slice(5)) - 1].toLowerCase() + ' de ' + f.inicio.slice(0, 4) + '.' }); cargar();
    } catch (err) { setF({ ...f, error: err.message }); }
  }

  async function depreciar() {
    try {
      const r = await rpc('depreciar_mes', { p_empresa: empresa.id, p_periodo: mes.replace('-', '') });
      setMsg({ ok: true, t: `Depreciación de ${MESES_LARGOS[Number(mes.slice(5)) - 1].toLowerCase()}: ${r.activos} activos por ${peso(r.total)} (asiento N° ${r.asiento ?? '—'}${r.estado === 'borrador' ? ', por aprobar' : ''}).` });
      cargar();
    } catch (err) { setMsg({ ok: false, t: err.message }); }
  }

  async function confirmarBaja(e) {
    e.preventDefault();
    try { await rpc('dar_baja_activo', { p_id: baja.a.id, p_fecha: baja.fecha, p_motivo: baja.motivo }); setBaja(null); setMsg({ ok: true, t: 'Activo dado de baja; su valor libro pasó a otros gastos fuera de explotación.' }); cargar(); }
    catch (err) { setBaja({ ...baja, error: err.message }); }
  }
  async function confirmarAnulacion(e) {
    e.preventDefault();
    try { await rpc('anular_depreciacion', { p_empresa: empresa.id, p_periodo: anular.periodo, p_motivo: anular.motivo }); setAnular(null); setMsg({ ok: true, t: 'Depreciación anulada.' }); cargar(); }
    catch (err) { setAnular({ ...anular, error: err.message }); }
  }

  if (!activos) return <section className="hoja"><Aviso msg={msg} /><p>Cargando activo fijo…</p></section>;
  const vigentes = activos.filter((a) => a.estado === 'activo');
  const tot = (k) => vigentes.reduce((s, a) => s + Number(a[k]), 0);
  const nombreMes = (p) => `${MESES_LARGOS[Number(p.slice(4)) - 1]} ${p.slice(0, 4)}`;
  const ctas = (tipo) => cuentas.filter((c) => c.tipo === tipo);

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Activo fijo · valor libro {peso(tot('valor_libro'))}</h1>
          <p className="chico">{vigentes.length} bienes en uso · costo {peso(tot('valor'))} · depreciación acumulada {peso(tot('depreciacion_acumulada'))}. Depreciación lineal según la vida útil del SII.</p>
        </div>
        <div className="filtros">
          {gestiona && <><SelectorMes valor={mes} alCambiar={setMes} /><button className="primario" onClick={depreciar} disabled={!vigentes.length}>Depreciar {MESES_LARGOS[Number(mes.slice(5)) - 1].toLowerCase()}</button></>}
          {gestiona && !f && <button onClick={nuevo}>+ Registrar bien</button>}
        </div>
      </header>
      <Aviso msg={msg} />

      {f && (
        <form className="formulario rejilla" onSubmit={guardar}>
          <h2 className="ancho">Registrar bien del activo fijo</h2>
          <label className="ancho">Nombre<input value={f.nombre} onChange={(e) => setF({ ...f, nombre: e.target.value })} maxLength={150} required autoFocus placeholder="Ej.: Notebook Dell Latitude" /></label>
          <label>Código interno (opcional)<input value={f.codigo} onChange={(e) => setF({ ...f, codigo: e.target.value })} maxLength={30} placeholder="AF-001" /></label>
          <label className="ancho" data-ayuda="Vida útil fijada por el SII. La acelerada (1/3 de la normal) solo aplica a bienes nuevos.">Tipo de bien (tabla SII)<select value={f.categoria} onChange={(e) => elegirCategoria(Number(e.target.value))}>
            {VIDA_UTIL_SII.map(([n, a, b], i) => <option key={n} value={i}>{n} · {a} años (acelerada {b})</option>)}
          </select></label>
          <label>Depreciación<select value={f.regimen} onChange={(e) => elegirCategoria(f.categoria, e.target.value)}>
            <option value="normal">Normal ({VIDA_UTIL_SII[f.categoria][1]} años)</option><option value="acelerada">Acelerada ({VIDA_UTIL_SII[f.categoria][2]} años)</option>
          </select></label>
          <label>Vida útil (meses)<input inputMode="numeric" value={f.meses} onChange={(e) => setF({ ...f, meses: e.target.value.replace(/\D/g, '') })} required /></label>
          <label>Fecha de compra<input type="date" value={f.fecha} max={hoy()} onChange={(e) => setF({ ...f, fecha: e.target.value, inicio: e.target.value.slice(0, 7) })} required /></label>
          <label data-ayuda="Mes desde el que se deprecia: normalmente el de compra o puesta en uso.">Depreciar desde<input type="month" value={f.inicio} onChange={(e) => setF({ ...f, inicio: e.target.value })} required /></label>
          <label>Valor neto de compra<CampoMonto valor={f.valor} alCambiar={(v) => setF({ ...f, valor: v })} required /></label>
          <label data-ayuda="Tributariamente los bienes quedan con valor $1 al terminar su vida útil.">Valor residual<CampoMonto valor={f.residual} alCambiar={(v) => setF({ ...f, residual: v })} /></label>
          <label data-ayuda="Solo para bienes que ya venían depreciándose en otro sistema.">Depreciación acumulada previa<CampoMonto valor={f.inicial} alCambiar={(v) => setF({ ...f, inicial: v })} /></label>
          <label className="ancho">Factura de compra (opcional)<select value={f.documento} onChange={(e) => { const d = compras.find((x) => x.id === e.target.value); setF({ ...f, documento: e.target.value, ...(d ? { fecha: d.fecha, inicio: d.fecha.slice(0, 7), valor: String(Math.round(d.neto)) } : {}) }); }}>
            <option value="">Sin vincular</option>
            {compras.map((d) => <option key={d.id} value={d.id}>{fecha(d.fecha)} · {d.tipo} N° {d.folio} · {d.razon_social} · neto {peso(d.neto)}</option>)}
          </select></label>
          <label>Cuenta del activo<select value={f.cuentaActivo} onChange={(e) => setF({ ...f, cuentaActivo: e.target.value })} required>
            <option value="">Elegir…</option>{ctas('activo').map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}</select></label>
          <label>Depreciación acumulada<select value={f.cuentaDep} onChange={(e) => setF({ ...f, cuentaDep: e.target.value })} required>
            <option value="">Elegir…</option>{ctas('activo').map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}</select></label>
          <label>Gasto por depreciación<select value={f.cuentaGasto} onChange={(e) => setF({ ...f, cuentaGasto: e.target.value })} required>
            <option value="">Elegir…</option>{ctas('gasto').map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}</select></label>
          {Number(f.valor) > 0 && Number(f.meses) > 0 && <p className="ancho chico">Cuota mensual: {peso(Math.round((Number(f.valor) - Number(f.residual || 0)) / Number(f.meses)))}. La compra se registra en Compras y ventas con la cuenta del activo; aquí solo se controla y deprecia.</p>}
          {f.error && <p className="ancho aviso error">{f.error}</p>}
          <div className="acciones ancho"><button type="button" onClick={() => setF(null)}>Cancelar</button><button className="primario">Registrar bien</button></div>
        </form>
      )}

      <div className="pestanas">
        <button className={ver === 'activos' ? 'activa' : ''} onClick={() => setVer('activos')}>Bienes ({activos.length})</button>
        <button className={ver === 'deps' ? 'activa' : ''} onClick={() => setVer('deps')}>Depreciaciones ({deps.length})</button>
      </div>

      {ver === 'activos' ? (
        <div className="scroll"><table className="tabla">
          <thead><tr><th>Bien</th><th>Compra</th><th className="n">Vida útil</th><th className="n">Costo</th><th className="n">Cuota mensual</th><th className="n">Dep. acumulada</th><th className="n">Valor libro</th><th>Último mes</th><th></th></tr></thead>
          <tbody>
            {activos.length === 0 && <tr><td colSpan={9} className="vacio">Aún no hay bienes registrados.</td></tr>}
            {activos.map((a) => (
              <tr key={a.id} className={a.estado === 'baja' ? 'anulado' : ''}>
                <td>{a.codigo && <small>{a.codigo} · </small>}{a.nombre}{a.categoria && <><br /><small>{a.categoria}</small></>}</td>
                <td className="nw">{fecha(a.fecha_compra)}</td><td className="n">{a.vida_util_meses / 12 >= 1 && a.vida_util_meses % 12 === 0 ? `${a.vida_util_meses / 12} años` : `${a.vida_util_meses} meses`}</td>
                <td className="n">{peso(a.valor)}</td><td className="n">{peso(a.cuota_mensual)}</td><td className="n">{peso(a.depreciacion_acumulada)}</td><td className="n">{peso(a.valor_libro)}</td>
                <td className="nw">{a.ultimo_periodo ? nombreMes(a.ultimo_periodo) : '—'}</td>
                <td>{a.estado === 'baja' ? <span className="etiqueta anulado" title={a.motivo_baja}>Baja {fecha(a.fecha_baja)}</span>
                  : gestiona && <button className="enlace" onClick={() => setBaja({ a, fecha: hoy(), motivo: '' })}>Dar de baja</button>}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      ) : (
        <table className="tabla">
          <thead><tr><th>Mes</th><th className="n">Bienes</th><th className="n">Monto</th><th>Asiento</th><th></th></tr></thead>
          <tbody>
            {deps.length === 0 && <tr><td colSpan={5} className="vacio">Aún no se registra depreciación.</td></tr>}
            {deps.map((d) => (
              <tr key={d.periodo}><td>{nombreMes(d.periodo)}</td><td className="n">{d.activos}</td><td className="n">{peso(d.total)}</td>
                <td>N° {d.numero ?? '—'}{d.estado === 'borrador' && <small> · por aprobar</small>}</td>
                <td>{gestiona && <button className="enlace" onClick={() => setAnular({ periodo: d.periodo, motivo: '' })}>Anular</button>}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {activos.length > 0 && <div className="acciones izquierda"><button onClick={() => csv('activo_fijo_' + hoy(), activos.map((a) => ({
        Codigo: a.codigo, Bien: a.nombre, Categoria: a.categoria, FechaCompra: fecha(a.fecha_compra), DepreciaDesde: fecha(a.inicio_depreciacion), VidaUtilMeses: a.vida_util_meses,
        Costo: a.valor, Residual: a.valor_residual, CuotaMensual: a.cuota_mensual, DepreciacionAcumulada: a.depreciacion_acumulada, ValorLibro: a.valor_libro,
        Estado: a.estado, FechaBaja: fecha(a.fecha_baja) })))}>Descargar registro (CSV)</button></div>}

      {baja && (
        <Dialogo titulo="Dar de baja" alCerrar={() => setBaja(null)}>
          <form onSubmit={confirmarBaja}>
            <h2>Dar de baja: {baja.a.nombre}</h2>
            <p>Sale el costo ({peso(baja.a.valor)}) y su depreciación acumulada; el valor libro ({peso(baja.a.valor_libro)}) se registra como otros gastos fuera de explotación.</p>
            <p className="chico">Deprecie primero el mes de la baja. Si el bien se vendió, emite la factura de venta en Compras y ventas.</p>
            <label>Fecha<input type="date" min={baja.a.fecha_compra} max={hoy()} value={baja.fecha} onChange={(e) => setBaja({ ...baja, fecha: e.target.value })} required /></label>
            <label>Motivo<input value={baja.motivo} onChange={(e) => setBaja({ ...baja, motivo: e.target.value })} minLength={5} maxLength={300} required placeholder="Venta, robo, obsolescencia…" /></label>
            {baja.error && <p className="aviso error">{baja.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setBaja(null)}>Cancelar</button><button className="peligro">Dar de baja</button></div>
          </form>
        </Dialogo>
      )}
      {anular && (
        <Dialogo titulo="Anular depreciación" alCerrar={() => setAnular(null)}>
          <form onSubmit={confirmarAnulacion}>
            <h2>Anular depreciación de {nombreMes(anular.periodo)}</h2>
            <p>Se anula su asiento y los bienes recuperan ese mes de valor libro. Luego puedes volver a depreciar el mes.</p>
            <label>Motivo<input value={anular.motivo} onChange={(e) => setAnular({ ...anular, motivo: e.target.value })} minLength={5} required autoFocus /></label>
            {anular.error && <p className="aviso error">{anular.error}</p>}
            <div className="acciones"><button type="button" onClick={() => setAnular(null)}>Cancelar</button><button className="peligro">Anular</button></div>
          </form>
        </Dialogo>
      )}
    </section>
  );
}
