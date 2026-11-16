import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { supabase, llamarFuncion } from '../lib/supabase';
import { useEmpresa } from '../lib/sesion';
import { auxiliares } from '../lib/maestros';
import { pesos, hoy, NOMBRE_DTE } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Selector, Aviso, useCarga } from '../components/ui';
import { calcularTotales, type ItemDte } from '../../../supabase/functions/_shared/sii/totales.ts';
import { validarRut, formatearRut } from '../../../supabase/functions/_shared/sii/rut.ts';

interface ItemForm { nombre: string; descripcion: string; cantidad: string; unidad: string; precio: string; descuentoPct: string; exento: boolean }
const itemVacio = (): ItemForm => ({ nombre: '', descripcion: '', cantidad: '1', unidad: '', precio: '', descuentoPct: '', exento: false });

export function Emitir() {
  const empresa = useEmpresa();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { datos: aux } = useCarga(() => auxiliares(empresa.id), [empresa.id]);
  const { datos: cafs } = useCarga(async () => {
    const { data } = await supabase.from('cafs').select('tipo_dte, folio_siguiente, folio_hasta').eq('empresa_id', empresa.id).eq('activo', true);
    return data ?? [];
  }, [empresa.id]);

  const [tipo, setTipo] = useState(Number(params.get('tipo') ?? 33));
  const [fechaEmision, setFecha] = useState(hoy());
  const [formaPago, setFormaPago] = useState<1 | 2 | 3>(1);
  const [fechaVenc, setFechaVenc] = useState('');
  const [receptor, setReceptor] = useState({ rut: '', razonSocial: '', giro: '', direccion: '', comuna: '', ciudad: '', correo: '' });
  const [items, setItems] = useState<ItemForm[]>([itemVacio()]);
  const [ref, setRef] = useState({ tipoDoc: params.get('refTipo') ?? '33', folio: params.get('refFolio') ?? '', fecha: params.get('refFecha') ?? '', codigo: '1', razon: '' });
  const [enviar, setEnviar] = useState(true);
  const [casoSet, setCasoSet] = useState('');
  const [error, setError] = useState('');
  const [resultado, setResultado] = useState<any>(null);
  const [cargando, setCargando] = useState(false);

  // Precarga desde un documento original (para notas de crédito o débito)
  useEffect(() => {
    const id = params.get('desde');
    if (!id) return;
    supabase.from('dte_emitidos').select('datos').eq('id', id).single().then(({ data }) => {
      if (!data) return;
      const d = data.datos as any;
      setReceptor({ ...receptor, ...d.receptor });
      setItems(d.items.map((i: ItemDte) => ({ nombre: i.nombre, descripcion: i.descripcion ?? '', cantidad: String(i.cantidad), unidad: i.unidad ?? '', precio: String(i.precio), descuentoPct: i.descuentoPct ? String(i.descuentoPct) : '', exento: !!i.exento })));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const boleta = tipo === 39 || tipo === 41;
  const nota = tipo === 56 || tipo === 61;
  const itemsDte: ItemDte[] = items.filter((i) => i.nombre && Number(i.precio) >= 0 && Number(i.cantidad) > 0).map((i) => ({
    nombre: i.nombre, descripcion: i.descripcion || undefined, cantidad: Number(i.cantidad), unidad: i.unidad || undefined,
    precio: Number(i.precio), descuentoPct: Number(i.descuentoPct) || undefined, exento: i.exento || undefined,
  }));
  const tot = useMemo(() => calcularTotales({ tipo, items: itemsDte }), [tipo, JSON.stringify(itemsDte)]);
  const caf = (cafs ?? []).find((c: any) => c.tipo_dte === tipo && c.folio_siguiente <= c.folio_hasta) as any;
  const setItem = (i: number, k: keyof ItemForm, v: string | boolean) => setItems(items.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  function elegirReceptor(rut: string) {
    const a = (aux ?? []).find((x) => formatearRut(x.rut) === rut || x.rut === rut);
    if (a) setReceptor({ rut: formatearRut(a.rut), razonSocial: a.razon_social, giro: a.giro ?? '', direccion: a.direccion ?? '', comuna: a.comuna ?? '', ciudad: a.ciudad ?? '', correo: a.correo_dte ?? a.correo ?? '' });
    else setReceptor({ ...receptor, rut });
  }

  async function emitir() {
    setError('');
    setResultado(null);
    const rutRec = boleta && !receptor.rut ? '66666666-6' : receptor.rut;
    if (!validarRut(rutRec)) return setError('RUT del receptor inválido');
    if (!boleta && (!receptor.razonSocial || !receptor.giro || !receptor.direccion || !receptor.comuna)) return setError('Complete razón social, giro, dirección y comuna del receptor');
    if (!itemsDte.length) return setError('Agregue al menos un ítem con nombre y precio');
    if (nota && (!ref.folio || !ref.fecha)) return setError('Indique el documento que se modifica (folio y fecha)');
    setCargando(true);
    try {
      const r = await llamarFuncion('dte-emitir', {
        empresaId: empresa.id,
        enviar,
        documento: {
          tipo, fechaEmision, formaPago: boleta ? undefined : formaPago, fechaVencimiento: formaPago === 2 && fechaVenc ? fechaVenc : undefined,
          indTraslado: tipo === 52 ? 1 : undefined,
          receptor: { ...receptor, rut: rutRec, razonSocial: receptor.razonSocial || (boleta ? 'Consumidor final' : '') },
          items: itemsDte,
          referencias: [
            // En el set de pruebas del SII cada documento referencia su caso (TpoDocRef SET).
            ...(casoSet ? [{ tipoDoc: 'SET', folio: 0, fecha: fechaEmision, razon: `CASO ${casoSet}` }] : []),
            ...(nota ? [{ tipoDoc: ref.tipoDoc, folio: ref.folio, fecha: ref.fecha, codigo: Number(ref.codigo), razon: ref.razon || (ref.codigo === '1' ? 'Anula documento' : ref.codigo === '2' ? 'Corrige texto' : 'Corrige montos') }] : []),
          ],
        },
      });
      setResultado(r);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCargando(false);
    }
  }

  return (
    <Pagina titulo="Emitir documento tributario" sub={`Ambiente SII: ${empresa.sii_ambiente === 'produccion' ? 'producción (documentos con validez tributaria)' : 'certificación (pruebas)'}`}>
      {resultado && (
        <Aviso tipo={resultado.errorEnvio ? 'alerta' : 'ok'}>
          {NOMBRE_DTE[resultado.tipo]} N° {resultado.folio} por {pesos(resultado.total)} {resultado.trackId ? `enviado al SII (Track ID ${resultado.trackId}).` : resultado.errorEnvio ? `firmado, pero el envío falló: ${resultado.errorEnvio}. Puede reenviarlo desde Documentos emitidos.` : 'firmado (no enviado).'}{' '}
          <button className="enlace" onClick={() => nav(`/emitidos?ver=${resultado.id}`)}>Ver documento</button>
        </Aviso>
      )}
      <div className="grid-3">
        <div className="span-2 pila">
          <Tarjeta titulo="Documento">
            <div className="grid-3 form">
              <Campo etiqueta="Tipo">
                <Selector value={tipo} onChange={(e) => setTipo(Number(e.target.value))}>
                  {[33, 34, 39, 41, 52, 56, 61].map((t) => <option key={t} value={t}>{t} · {NOMBRE_DTE[t]}</option>)}
                </Selector>
              </Campo>
              <Campo etiqueta="Fecha de emisión"><Entrada type="date" value={fechaEmision} onChange={(e) => setFecha(e.target.value)} /></Campo>
              {!boleta && (
                <Campo etiqueta="Forma de pago">
                  <Selector value={formaPago} onChange={(e) => setFormaPago(Number(e.target.value) as 1 | 2 | 3)}>
                    <option value={1}>Contado</option><option value={2}>Crédito</option><option value={3}>Sin costo</option>
                  </Selector>
                </Campo>
              )}
              {formaPago === 2 && !boleta && <Campo etiqueta="Vencimiento"><Entrada type="date" value={fechaVenc} onChange={(e) => setFechaVenc(e.target.value)} /></Campo>}
            </div>
            {empresa.sii_ambiente === 'certificacion' && (
              <div className="grid-3 form">
                <Campo etiqueta="Caso del set de pruebas" ayuda="Solo para la certificación SII, ej. 4123456-1"><Entrada value={casoSet} onChange={(e) => setCasoSet(e.target.value)} /></Campo>
              </div>
            )}
            {!caf && <Aviso tipo="alerta">No hay folios disponibles para {NOMBRE_DTE[tipo]}. Cargue un CAF en Configuración.</Aviso>}
            {caf && <p className="sub pequeno">Próximo folio: {caf.folio_siguiente} (quedan {caf.folio_hasta - caf.folio_siguiente + 1})</p>}
          </Tarjeta>

          <Tarjeta titulo={boleta ? 'Cliente (opcional)' : 'Receptor'}>
            <datalist id="dl-aux">{(aux ?? []).filter((a) => a.es_cliente).map((a) => <option key={a.id} value={formatearRut(a.rut)}>{a.razon_social}</option>)}</datalist>
            <div className="grid-3 form">
              <Campo etiqueta="RUT"><Entrada list="dl-aux" value={receptor.rut} onChange={(e) => elegirReceptor(e.target.value)} placeholder={boleta ? '66.666.666-6' : ''} /></Campo>
              <Campo etiqueta="Razón social"><Entrada value={receptor.razonSocial} onChange={(e) => setReceptor({ ...receptor, razonSocial: e.target.value })} /></Campo>
              {!boleta && <Campo etiqueta="Giro"><Entrada value={receptor.giro} onChange={(e) => setReceptor({ ...receptor, giro: e.target.value })} maxLength={40} /></Campo>}
              <Campo etiqueta="Dirección"><Entrada value={receptor.direccion} onChange={(e) => setReceptor({ ...receptor, direccion: e.target.value })} /></Campo>
              <Campo etiqueta="Comuna"><Entrada value={receptor.comuna} onChange={(e) => setReceptor({ ...receptor, comuna: e.target.value })} /></Campo>
              {!boleta && <Campo etiqueta="Correo"><Entrada type="email" value={receptor.correo} onChange={(e) => setReceptor({ ...receptor, correo: e.target.value })} /></Campo>}
            </div>
          </Tarjeta>

          {nota && (
            <Tarjeta titulo="Documento de referencia">
              <div className="grid-3 form">
                <Campo etiqueta="Tipo"><Selector value={ref.tipoDoc} onChange={(e) => setRef({ ...ref, tipoDoc: e.target.value })}>{[33, 34, 39, 56, 61].map((t) => <option key={t} value={t}>{NOMBRE_DTE[t]}</option>)}</Selector></Campo>
                <Campo etiqueta="Folio"><Entrada value={ref.folio} onChange={(e) => setRef({ ...ref, folio: e.target.value.replace(/\D/g, '') })} /></Campo>
                <Campo etiqueta="Fecha"><Entrada type="date" value={ref.fecha} onChange={(e) => setRef({ ...ref, fecha: e.target.value })} /></Campo>
                <Campo etiqueta="Código"><Selector value={ref.codigo} onChange={(e) => setRef({ ...ref, codigo: e.target.value })}><option value="1">1 · Anula documento</option><option value="2">2 · Corrige texto</option><option value="3">3 · Corrige montos</option></Selector></Campo>
                <Campo etiqueta="Razón"><Entrada value={ref.razon} onChange={(e) => setRef({ ...ref, razon: e.target.value })} maxLength={90} /></Campo>
              </div>
            </Tarjeta>
          )}

          <Tarjeta titulo="Detalle">
            <table className="tabla editor">
              <thead><tr><th style={{ width: '32%' }}>Ítem</th><th className="num">Cantidad</th><th>Unidad</th><th className="num">Precio {boleta ? '(con IVA)' : 'neto'}</th><th className="num">Desc. %</th><th>Exento</th><th className="num">Monto</th><th /></tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td><Entrada value={it.nombre} onChange={(e) => setItem(i, 'nombre', e.target.value)} maxLength={80} placeholder="Nombre" /><Entrada className="sec" value={it.descripcion} onChange={(e) => setItem(i, 'descripcion', e.target.value)} placeholder="Descripción (opcional)" /></td>
                    <td><Entrada className="num" inputMode="decimal" value={it.cantidad} onChange={(e) => setItem(i, 'cantidad', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                    <td><Entrada value={it.unidad} onChange={(e) => setItem(i, 'unidad', e.target.value)} maxLength={4} /></td>
                    <td><Entrada className="num" inputMode="decimal" value={it.precio} onChange={(e) => setItem(i, 'precio', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                    <td><Entrada className="num" inputMode="decimal" value={it.descuentoPct} onChange={(e) => setItem(i, 'descuentoPct', e.target.value.replace(/[^\d.]/g, ''))} /></td>
                    <td className="centro"><input type="checkbox" checked={it.exento || tipo === 34 || tipo === 41} disabled={tipo === 34 || tipo === 41} onChange={(e) => setItem(i, 'exento', e.target.checked)} aria-label="Exento" /></td>
                    <td className="num">{pesos(Math.round((Number(it.cantidad) || 0) * (Number(it.precio) || 0) * (1 - (Number(it.descuentoPct) || 0) / 100)))}</td>
                    <td><button className="btn btn-fantasma" onClick={() => setItems(items.filter((_, j) => j !== i))} aria-label="Quitar">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <button className="enlace" onClick={() => setItems([...items, itemVacio()])}>+ Agregar ítem</button>
          </Tarjeta>
        </div>
        <div>
          <Tarjeta titulo="Totales" className="pegajosa">
            <dl className="ratios grande">
              {tot.neto > 0 && <><dt>Neto</dt><dd>{pesos(tot.neto)}</dd></>}
              {tot.exento > 0 && <><dt>Exento</dt><dd>{pesos(tot.exento)}</dd></>}
              {tot.iva > 0 && <><dt>IVA 19%</dt><dd>{pesos(tot.iva)}</dd></>}
              <dt className="fuerte">Total</dt><dd className="fuerte">{pesos(tot.total)}</dd>
            </dl>
            <label className="check"><input type="checkbox" checked={enviar} onChange={(e) => setEnviar(e.target.checked)} /> Enviar al SII al emitir</label>
            <Aviso tipo="error">{error}</Aviso>
            <Boton onClick={emitir} cargando={cargando} disabled={!caf} className="ancho">Firmar y emitir</Boton>
            <p className="sub pequeno">El documento se timbra con el CAF, se firma con el certificado digital de la empresa y queda registrado en la bitácora de auditoría.</p>
          </Tarjeta>
        </div>
      </div>
    </Pagina>
  );
}
