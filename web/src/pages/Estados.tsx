import { Fragment, useState } from 'react';
import { rpc, supabase } from '../lib/supabase';
import { useEmpresa, useSesion } from '../lib/sesion';
import { pesos, hoy, inicioAnio, csv } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Cargando, Aviso, Estado, useCarga } from '../components/ui';

export function Estados() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const [desde, setDesde] = useState(inicioAnio());
  const [hasta, setHasta] = useState(hoy());
  const [msg, setMsg] = useState('');
  const er = useCarga<any[]>(() => rpc('estado_resultados', { p_empresa: empresa.id, p_desde: desde, p_hasta: hasta }), [empresa.id, desde, hasta]);
  const bg = useCarga<any[]>(() => rpc('balance_general', { p_empresa: empresa.id, p_hasta: hasta }), [empresa.id, hasta]);
  const per = useCarga(async () => {
    const { data } = await supabase.from('periodos').select('*').eq('empresa_id', empresa.id).order('anio', { ascending: false }).order('mes', { ascending: false }).limit(24);
    return data ?? [];
  }, [empresa.id]);

  const secciones = ['Activo', 'Pasivo', 'Patrimonio'];
  const total = (s: string) => (bg.datos ?? []).filter((f) => f.seccion === s).reduce((a, f) => a + Number(f.saldo), 0);

  async function cambiarPeriodo(p: any) {
    setMsg('');
    try {
      await rpc(p.estado === 'abierto' ? 'cerrar_periodo' : 'reabrir_periodo', { p_empresa: empresa.id, p_anio: p.anio, p_mes: p.mes });
      per.recargar();
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <Pagina titulo="Estados financieros" sub="Estado de resultados y balance general a partir de los comprobantes contabilizados."
      acciones={<Boton variante="secundario" onClick={() => window.print()}>Imprimir</Boton>}>
      <div className="filtros">
        <Campo etiqueta="Desde"><Entrada type="date" value={desde} onChange={(e) => setDesde(e.target.value)} /></Campo>
        <Campo etiqueta="Hasta"><Entrada type="date" value={hasta} onChange={(e) => setHasta(e.target.value)} /></Campo>
      </div>
      <div className="grid-2">
        <Tarjeta titulo="Estado de resultados" extra={<button className="enlace" onClick={() => csv('estado_resultados.csv', er.datos ?? [])}>CSV</button>}>
          {er.cargando ? <Cargando /> : (
            <table className="tabla estado">
              <tbody>
                {(er.datos ?? []).map((f) => (
                  <tr key={f.orden} className={f.es_total ? 'total' : ''}><td>{f.concepto}</td><td className={`num ${Number(f.monto) < 0 && f.es_total ? 'error-txt' : ''}`}>{pesos(f.monto)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Tarjeta>
        <Tarjeta titulo={`Balance general al ${new Date(hasta + 'T12:00').toLocaleDateString('es-CL')}`} extra={<button className="enlace" onClick={() => csv('balance_general.csv', bg.datos ?? [])}>CSV</button>}>
          {bg.cargando ? <Cargando /> : (
            <table className="tabla compacta">
              <tbody>
                {secciones.map((s) => (
                  <Fragment key={s}>
                    <tr className="grupo"><td colSpan={2}>{s}</td></tr>
                    {(bg.datos ?? []).filter((f) => f.seccion === s).map((f) => (
                      <tr key={f.codigo}><td className="sangria"><span className="mono">{f.codigo}</span> {f.nombre}</td><td className="num">{pesos(f.saldo)}</td></tr>
                    ))}
                    <tr className="total"><td>Total {s.toLowerCase()}</td><td className="num">{pesos(total(s))}</td></tr>
                  </Fragment>
                ))}
                <tr className="total"><td>Pasivo + patrimonio</td><td className="num">{pesos(total('Pasivo') + total('Patrimonio'))}</td></tr>
              </tbody>
            </table>
          )}
          {!bg.cargando && Math.round(total('Activo')) !== Math.round(total('Pasivo') + total('Patrimonio')) && <Aviso tipo="error">El balance no cuadra; revise comprobantes.</Aviso>}
        </Tarjeta>
      </div>
      <Tarjeta titulo="Períodos contables">
        <Aviso tipo="error">{msg}</Aviso>
        <table className="tabla compacta">
          <thead><tr><th>Período</th><th>Estado</th><th /></tr></thead>
          <tbody>
            {(per.datos ?? []).map((p: any) => (
              <tr key={`${p.anio}-${p.mes}`}>
                <td>{String(p.mes).padStart(2, '0')}/{p.anio}</td><td><Estado valor={p.estado} /></td>
                <td className="num">
                  {p.estado === 'abierto' && puede('admin', 'contador') && <Boton variante="secundario" onClick={() => cambiarPeriodo(p)}>Cerrar</Boton>}
                  {p.estado === 'cerrado' && puede('admin') && <Boton variante="fantasma" onClick={() => cambiarPeriodo(p)}>Reabrir</Boton>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Tarjeta>
    </Pagina>
  );
}
