import { Fragment, useState } from 'react';
import { rpc } from '../lib/supabase';
import { useEmpresa } from '../lib/sesion';
import { cuentas } from '../lib/maestros';
import { pesos, fecha, hoy, inicioAnio, csv, periodoActual, NOMBRE_DTE } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Selector, Vacio, Cargando, Aviso, useCarga } from '../components/ui';

type Libro = 'diario' | 'mayor' | 'balance' | 'ventas' | 'compras';

export function Libros() {
  const empresa = useEmpresa();
  const [libro, setLibro] = useState<Libro>('balance');
  const [desde, setDesde] = useState(inicioAnio());
  const [hasta, setHasta] = useState(hoy());
  const [periodo, setPeriodo] = useState(periodoActual());
  const [cuenta, setCuenta] = useState('');
  const { datos: plan } = useCarga(() => cuentas(empresa.id), [empresa.id]);

  const { datos, error, cargando } = useCarga<any[]>(async () => {
    if (libro === 'diario') return rpc('libro_diario', { p_empresa: empresa.id, p_desde: desde, p_hasta: hasta });
    if (libro === 'balance') return rpc('balance_8_columnas', { p_empresa: empresa.id, p_desde: desde, p_hasta: hasta });
    if (libro === 'mayor') return cuenta ? rpc('libro_mayor', { p_empresa: empresa.id, p_cuenta: cuenta, p_desde: desde, p_hasta: hasta }) : [];
    if (libro === 'ventas') return rpc('libro_ventas', { p_empresa: empresa.id, p_periodo: periodo });
    return rpc('libro_compras', { p_empresa: empresa.id, p_periodo: periodo });
  }, [empresa.id, libro, desde, hasta, cuenta, periodo]);

  const filas = datos ?? [];
  const porPeriodo = libro === 'ventas' || libro === 'compras';

  return (
    <Pagina titulo="Libros contables y tributarios" sub="Diario, mayor, balance de 8 columnas y libros de compras y ventas."
      acciones={<Boton variante="secundario" onClick={() => csv(`libro_${libro}.csv`, filas)} disabled={!filas.length}>Exportar CSV</Boton>}>
      <div className="pestanas" role="tablist">
        {([['balance', 'Balance 8 columnas'], ['diario', 'Libro diario'], ['mayor', 'Libro mayor'], ['ventas', 'Libro de ventas'], ['compras', 'Libro de compras']] as [Libro, string][]).map(([k, t]) => (
          <button key={k} role="tab" aria-selected={libro === k} className={libro === k ? 'activa' : ''} onClick={() => setLibro(k)}>{t}</button>
        ))}
      </div>
      <div className="filtros">
        {porPeriodo ? (
          <Campo etiqueta="Período"><Entrada type="month" value={`${periodo.slice(0, 4)}-${periodo.slice(4)}`} onChange={(e) => setPeriodo(e.target.value.replace('-', ''))} /></Campo>
        ) : (
          <>
            <Campo etiqueta="Desde"><Entrada type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
            <Campo etiqueta="Hasta"><Entrada type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
          </>
        )}
        {libro === 'mayor' && (
          <Campo etiqueta="Cuenta">
            <Selector value={cuenta} onChange={(e) => setCuenta(e.target.value)}>
              <option value="">Seleccione…</option>
              {(plan ?? []).filter((c) => c.imputable).map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
            </Selector>
          </Campo>
        )}
      </div>
      <Aviso tipo="error">{error}</Aviso>
      <Tarjeta>
        {cargando ? <Cargando /> : !filas.length ? <Vacio>{libro === 'mayor' && !cuenta ? 'Seleccione una cuenta.' : 'Sin movimientos.'}</Vacio> : (
          <>
            {libro === 'balance' && <Balance8 filas={filas} />}
            {libro === 'diario' && <Diario filas={filas} />}
            {libro === 'mayor' && <Mayor filas={filas} />}
            {porPeriodo && <LibroIva filas={filas} compras={libro === 'compras'} />}
          </>
        )}
      </Tarjeta>
    </Pagina>
  );
}

function Balance8({ filas }: { filas: any[] }) {
  const cols = ['debitos', 'creditos', 'deudor', 'acreedor', 'activo', 'pasivo', 'perdida', 'ganancia'];
  const tot = Object.fromEntries(cols.map((c) => [c, filas.reduce((s, f) => s + Number(f[c]), 0)]));
  const resInv = tot.activo - tot.pasivo;
  const resRes = tot.ganancia - tot.perdida;
  return (
    <div className="desborde">
      <table className="tabla compacta">
        <thead>
          <tr><th rowSpan={2}>Cuenta</th><th colSpan={2} className="centro">Sumas</th><th colSpan={2} className="centro">Saldos</th><th colSpan={2} className="centro">Inventario</th><th colSpan={2} className="centro">Resultados</th></tr>
          <tr>{['Débitos', 'Créditos', 'Deudor', 'Acreedor', 'Activo', 'Pasivo', 'Pérdida', 'Ganancia'].map((h) => <th key={h} className="num">{h}</th>)}</tr>
        </thead>
        <tbody>
          {filas.map((f) => (
            <tr key={f.codigo}><td><span className="mono">{f.codigo}</span> {f.nombre}</td>{cols.map((c) => <td key={c} className="num">{Number(f[c]) ? pesos(f[c]) : ''}</td>)}</tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="total"><td>Sumas</td>{cols.map((c) => <td key={c} className="num">{pesos(tot[c])}</td>)}</tr>
          <tr><td>Resultado del ejercicio</td><td colSpan={4} /><td className="num">{resInv < 0 ? pesos(-resInv) : ''}</td><td className="num">{resInv > 0 ? pesos(resInv) : ''}</td><td className="num">{resRes > 0 ? pesos(resRes) : ''}</td><td className="num">{resRes < 0 ? pesos(-resRes) : ''}</td></tr>
          <tr className="total"><td>Totales iguales</td><td colSpan={4} className={tot.debitos === tot.creditos ? 'ok-txt' : 'error-txt'}>{tot.debitos === tot.creditos ? '✓ cuadrado' : '✕ descuadrado'}</td>
            <td className="num">{pesos(Math.max(tot.activo, tot.pasivo))}</td><td className="num">{pesos(Math.max(tot.activo, tot.pasivo))}</td>
            <td className="num">{pesos(Math.max(tot.perdida, tot.ganancia))}</td><td className="num">{pesos(Math.max(tot.perdida, tot.ganancia))}</td></tr>
        </tfoot>
      </table>
    </div>
  );
}

function Diario({ filas }: { filas: any[] }) {
  const grupos = new Map<string, any[]>();
  for (const f of filas) grupos.set(f.asiento_id, [...(grupos.get(f.asiento_id) ?? []), f]);
  const td = filas.reduce((s, f) => s + Number(f.debe), 0);
  const th = filas.reduce((s, f) => s + Number(f.haber), 0);
  return (
    <table className="tabla compacta">
      <thead><tr><th>Cuenta</th><th>Auxiliar</th><th className="num">Debe</th><th className="num">Haber</th></tr></thead>
      <tbody>
        {[...grupos.values()].map((ls) => (
          <Fragment key={ls[0].asiento_id}>
            <tr className="grupo"><td colSpan={4}>N° {ls[0].numero} · {fecha(ls[0].fecha)} · <span className="cap">{ls[0].tipo}</span> · {ls[0].glosa_asiento}</td></tr>
            {ls.map((l) => (
              <tr key={l.linea}>
                <td className={Number(l.haber) ? 'sangria' : ''}><span className="mono">{l.cuenta_codigo}</span> {l.cuenta_nombre}</td>
                <td>{l.auxiliar_nombre ?? ''}</td>
                <td className="num">{Number(l.debe) ? pesos(l.debe) : ''}</td>
                <td className="num">{Number(l.haber) ? pesos(l.haber) : ''}</td>
              </tr>
            ))}
          </Fragment>
        ))}
      </tbody>
      <tfoot><tr className="total"><td colSpan={2}>Totales</td><td className="num">{pesos(td)}</td><td className="num">{pesos(th)}</td></tr></tfoot>
    </table>
  );
}

function Mayor({ filas }: { filas: any[] }) {
  return (
    <table className="tabla compacta">
      <thead><tr><th>Fecha</th><th>N°</th><th>Glosa</th><th>Auxiliar</th><th className="num">Debe</th><th className="num">Haber</th><th className="num">Saldo</th></tr></thead>
      <tbody>
        {filas.map((f, i) => (
          <tr key={i} className={i === 0 ? 'grupo' : ''}>
            <td>{i === 0 ? '' : fecha(f.fecha)}</td><td className="mono">{f.numero ?? ''}</td><td>{f.glosa}</td><td>{f.auxiliar ?? ''}</td>
            <td className="num">{f.debe ? pesos(f.debe) : ''}</td><td className="num">{f.haber ? pesos(f.haber) : ''}</td><td className="num">{pesos(f.saldo)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LibroIva({ filas, compras }: { filas: any[]; compras: boolean }) {
  const signo = (f: any) => (f.tipo === 61 ? -1 : 1);
  const sum = (k: string) => filas.reduce((s, f) => s + signo(f) * Number(f[k]), 0);
  return (
    <table className="tabla compacta">
      <thead><tr><th>Fecha</th><th>Tipo</th><th>Folio</th><th>RUT</th><th>Razón social</th><th className="num">Exento</th><th className="num">Neto</th><th className="num">IVA</th>{compras && <th className="num">IVA no rec.</th>}<th className="num">Total</th></tr></thead>
      <tbody>
        {filas.map((f) => (
          <tr key={f.id}>
            <td>{fecha(f.fecha_emision)}</td><td>{NOMBRE_DTE[f.tipo] ?? f.tipo}</td><td className="mono">{f.folio}</td>
            <td className="mono">{compras ? f.emisor_rut : f.receptor_rut}</td><td>{compras ? f.emisor_razon : f.receptor_razon}</td>
            <td className="num">{pesos(f.exento)}</td><td className="num">{pesos(f.neto)}</td><td className="num">{pesos(f.iva)}</td>
            {compras && <td className="num">{pesos(f.iva_no_recuperable)}</td>}<td className="num">{pesos(f.total)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot><tr className="total"><td colSpan={5}>Totales (notas de crédito restan)</td><td className="num">{pesos(sum('exento'))}</td><td className="num">{pesos(sum('neto'))}</td><td className="num">{pesos(sum('iva'))}</td>{compras && <td className="num">{pesos(sum('iva_no_recuperable'))}</td>}<td className="num">{pesos(sum('total'))}</td></tr></tfoot>
    </table>
  );
}
