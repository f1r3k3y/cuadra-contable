// Representación impresa del DTE con timbre electrónico en PDF417 (exigido por el SII).
import { useEffect, useRef } from 'react';
import { pesos, fecha, NOMBRE_DTE } from '../lib/fmt';
import { formatearRut } from '../../../supabase/functions/_shared/sii/rut.ts';

export function Impreso({ dte, empresa }: { dte: any; empresa: any }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const d = dte.datos;
  useEffect(() => {
    if (!canvas.current || !dte.ted) return;
    const c = canvas.current;
    // bwip-js es pesado: se carga solo al abrir un documento.
    import('bwip-js/browser')
      .then((m) => m.default.toCanvas(c, { bcid: 'pdf417', text: dte.ted, eclevel: 5, columns: 12, scale: 2, height: 2 } as never))
      .catch((e) => console.error('No se pudo generar el timbre', e));
  }, [dte.ted]);

  return (
    <div className="impreso">
      <div className="impreso-cab">
        <div>
          <h2>{empresa.razon_social}</h2>
          <p>{empresa.giro}</p>
          <p>{empresa.direccion}, {empresa.comuna}</p>
        </div>
        <div className="impreso-recuadro">
          <div>R.U.T.: {formatearRut(empresa.rut)}</div>
          <div className="fuerte">{(NOMBRE_DTE[dte.tipo] ?? 'DTE').toUpperCase()} ELECTRÓNICA</div>
          <div>N° {dte.folio}</div>
          <div className="pequeno">S.I.I. – {(empresa.comuna || '').toUpperCase()}</div>
        </div>
      </div>
      <div className="impreso-datos">
        <div><strong>Señor(es):</strong> {d.receptor.razonSocial}</div>
        <div><strong>R.U.T.:</strong> {formatearRut(d.receptor.rut)}</div>
        {d.receptor.giro && <div><strong>Giro:</strong> {d.receptor.giro}</div>}
        {d.receptor.direccion && <div><strong>Dirección:</strong> {d.receptor.direccion}, {d.receptor.comuna}</div>}
        <div><strong>Fecha emisión:</strong> {fecha(d.fechaEmision)}</div>
        {d.formaPago && <div><strong>Forma de pago:</strong> {['', 'Contado', 'Crédito', 'Sin costo'][d.formaPago]}</div>}
      </div>
      <table className="tabla compacta">
        <thead><tr><th>Descripción</th><th className="num">Cantidad</th><th className="num">Precio</th><th className="num">Desc.</th><th className="num">Monto</th></tr></thead>
        <tbody>
          {d.items.map((i: any, k: number) => (
            <tr key={k}>
              <td>{i.nombre}{i.exento ? ' (exento)' : ''}{i.descripcion && <div className="pequeno">{i.descripcion}</div>}</td>
              <td className="num">{i.cantidad} {i.unidad ?? ''}</td>
              <td className="num">{pesos(i.precio)}</td>
              <td className="num">{i.descuentoPct ? `${i.descuentoPct}%` : ''}</td>
              <td className="num">{pesos(Math.round(i.cantidad * i.precio * (1 - (i.descuentoPct ?? 0) / 100)))}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {d.referencias?.length > 0 && (
        <p className="pequeno">Referencia: {d.referencias.map((r: any) => `${NOMBRE_DTE[r.tipoDoc] ?? r.tipoDoc} N° ${r.folio} del ${fecha(r.fecha)} — ${r.razon ?? ''}`).join('; ')}</p>
      )}
      <div className="impreso-pie">
        <div className="timbre">
          <canvas ref={canvas} />
          <div className="pequeno centro">Timbre Electrónico SII<br />Res. {empresa.sii_resolucion_numero} de {empresa.sii_resolucion_fecha?.slice(0, 4)} — Verifique documento: www.sii.cl</div>
        </div>
        <dl className="ratios">
          {Number(dte.neto) > 0 && <><dt>Neto</dt><dd>{pesos(dte.neto)}</dd></>}
          {Number(dte.exento) > 0 && <><dt>Exento</dt><dd>{pesos(dte.exento)}</dd></>}
          {Number(dte.iva) > 0 && <><dt>IVA 19%</dt><dd>{pesos(dte.iva)}</dd></>}
          <dt className="fuerte">Total</dt><dd className="fuerte">{pesos(dte.total)}</dd>
        </dl>
      </div>
    </div>
  );
}
