import { useState, type FormEvent } from 'react';
import { supabase, llamarFuncion, rpc } from '../lib/supabase';
import { useEmpresa, useSesion, type Rol } from '../lib/sesion';
import { cuentas } from '../lib/maestros';
import { fecha, fechaHora, leerArchivo, NOMBRE_DTE } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Selector, Aviso, Cargando, useCarga } from '../components/ui';
import { formatearRut } from '../../../supabase/functions/_shared/sii/rut.ts';

export function Configuracion() {
  const { puede } = useSesion();
  return (
    <Pagina titulo="Configuración" sub="Datos tributarios, credenciales del SII, usuarios y cuentas automáticas.">
      <div className="grid-2">
        <DatosEmpresa />
        <div className="pila">
          <Certificado />
          <Folios />
        </div>
      </div>
      <div className="grid-2">
        <Usuarios />
        <div className="pila">
          {puede('admin', 'contador') && <CuentasAutomaticas />}
          {puede('admin', 'contador') && <CentrosCosto />}
        </div>
      </div>
    </Pagina>
  );
}

function DatosEmpresa() {
  const empresa = useEmpresa();
  const { puede, recargar } = useSesion();
  const [f, setF] = useState({ ...empresa, actecos: empresa.actecos.join(', ') });
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);
  const editable = puede('admin');

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    if (f.sii_ambiente === 'produccion' && empresa.sii_ambiente !== 'produccion' && !confirm('Al pasar a producción, los documentos emitidos tendrán validez tributaria. ¿Ya completó la certificación del SII y tiene la resolución de autorización?')) return;
    const { error } = await supabase.from('empresas').update({
      razon_social: f.razon_social, nombre_fantasia: f.nombre_fantasia || null, giro: f.giro,
      actecos: f.actecos.split(/[,\s]+/).filter(Boolean).map(Number), direccion: f.direccion, comuna: f.comuna, ciudad: f.ciudad || null,
      correo: f.correo || null, telefono: f.telefono || null, sii_ambiente: f.sii_ambiente,
      sii_resolucion_numero: Number(f.sii_resolucion_numero) || 0, sii_resolucion_fecha: f.sii_resolucion_fecha || null,
      tasa_ppm: Number(f.tasa_ppm), remanente_inicial: Number(f.remanente_inicial) || 0,
    }).eq('id', empresa.id);
    setMsg(error ? { tipo: 'error', txt: error.message } : { tipo: 'ok', txt: 'Datos guardados' });
    if (!error) recargar();
  }
  const set = (k: string) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  return (
    <Tarjeta titulo="Empresa y SII">
      <form onSubmit={guardar} className="form">
        <fieldset disabled={!editable} className="grid-2">
          <Campo etiqueta="RUT"><Entrada value={formatearRut(empresa.rut)} disabled /></Campo>
          <Campo etiqueta="Razón social"><Entrada value={f.razon_social} onChange={set('razon_social')} /></Campo>
          <Campo etiqueta="Nombre de fantasía"><Entrada value={f.nombre_fantasia ?? ''} onChange={set('nombre_fantasia')} /></Campo>
          <Campo etiqueta="Giro"><Entrada value={f.giro} onChange={set('giro')} maxLength={80} /></Campo>
          <Campo etiqueta="Actividades económicas" ayuda="Códigos SII separados por coma (máx. 4)"><Entrada value={f.actecos} onChange={set('actecos')} /></Campo>
          <Campo etiqueta="Dirección"><Entrada value={f.direccion} onChange={set('direccion')} /></Campo>
          <Campo etiqueta="Comuna"><Entrada value={f.comuna} onChange={set('comuna')} /></Campo>
          <Campo etiqueta="Ciudad"><Entrada value={f.ciudad ?? ''} onChange={set('ciudad')} /></Campo>
          <Campo etiqueta="Correo de intercambio"><Entrada type="email" value={f.correo ?? ''} onChange={set('correo')} /></Campo>
          <Campo etiqueta="Teléfono"><Entrada value={f.telefono ?? ''} onChange={set('telefono')} /></Campo>
          <Campo etiqueta="Ambiente SII">
            <Selector value={f.sii_ambiente} onChange={set('sii_ambiente')}>
              <option value="certificacion">Certificación (maullin.sii.cl)</option>
              <option value="produccion">Producción (palena.sii.cl)</option>
            </Selector>
          </Campo>
          <Campo etiqueta="Fecha de resolución SII" ayuda="En certificación: la fecha que indica el SII al postular"><Entrada type="date" value={f.sii_resolucion_fecha ?? ''} onChange={set('sii_resolucion_fecha')} /></Campo>
          <Campo etiqueta="Número de resolución" ayuda="0 en certificación"><Entrada inputMode="numeric" value={String(f.sii_resolucion_numero)} onChange={set('sii_resolucion_numero')} /></Campo>
          <Campo etiqueta="Tasa PPM (%)"><Entrada inputMode="decimal" value={String(f.tasa_ppm)} onChange={set('tasa_ppm')} /></Campo>
          <Campo etiqueta="Remanente crédito fiscal inicial"><Entrada inputMode="numeric" value={String(f.remanente_inicial)} onChange={set('remanente_inicial')} /></Campo>
        </fieldset>
        {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
        {editable && <div className="acciones fin"><Boton type="submit">Guardar</Boton></div>}
      </form>
    </Tarjeta>
  );
}

function Certificado() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const { datos, recargar } = useCarga(async () => {
    const { data } = await supabase.from('certificados').select('titular_nombre, titular_rut, valido_hasta, creado_en').eq('empresa_id', empresa.id).eq('activo', true).maybeSingle();
    return data;
  }, [empresa.id]);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [clave, setClave] = useState('');
  const [rut, setRut] = useState('');
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);
  const [cargando, setCargando] = useState(false);

  async function subir(e: FormEvent) {
    e.preventDefault();
    if (!archivo) return;
    setMsg(null);
    setCargando(true);
    try {
      const pfxBase64 = await leerArchivo(archivo, 'base64');
      await llamarFuncion('credenciales', { empresaId: empresa.id, accion: 'certificado', pfxBase64, clave, rutTitular: rut || undefined });
      setClave('');
      setArchivo(null);
      setMsg({ tipo: 'ok', txt: 'Certificado cargado y cifrado' });
      recargar();
    } catch (e) {
      setMsg({ tipo: 'error', txt: (e as Error).message });
    } finally {
      setCargando(false);
    }
  }

  const dias = datos ? Math.floor((new Date(datos.valido_hasta).getTime() - Date.now()) / 86400000) : 0;
  return (
    <Tarjeta titulo="Certificado digital">
      {datos ? (
        <dl className="ratios">
          <dt>Titular</dt><dd>{datos.titular_nombre}</dd>
          <dt>RUT titular</dt><dd className="mono">{formatearRut(datos.titular_rut)}</dd>
          <dt>Vence</dt><dd className={dias < 30 ? 'error-txt' : ''}>{fecha(datos.valido_hasta)} ({dias} días)</dd>
        </dl>
      ) : <Aviso tipo="alerta">Sin certificado. Es necesario para firmar documentos y conectarse al SII.</Aviso>}
      {puede('admin') && (
        <form onSubmit={subir} className="form">
          <Campo etiqueta="Archivo .pfx o .p12"><input type="file" accept=".pfx,.p12" onChange={(e) => setArchivo(e.target.files?.[0] ?? null)} /></Campo>
          <div className="grid-2">
            <Campo etiqueta="Clave del certificado"><Entrada type="password" value={clave} onChange={(e) => setClave(e.target.value)} autoComplete="off" /></Campo>
            <Campo etiqueta="RUT del titular" ayuda="Si no viene en el certificado"><Entrada value={rut} onChange={(e) => setRut(e.target.value)} /></Campo>
          </div>
          {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
          <Boton type="submit" disabled={!archivo || !clave} cargando={cargando}>{datos ? 'Reemplazar certificado' : 'Cargar certificado'}</Boton>
          <p className="sub pequeno">El archivo y la clave se cifran con AES-256-GCM en el servidor y nunca vuelven al navegador.</p>
        </form>
      )}
    </Tarjeta>
  );
}

function Folios() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const { datos, recargar } = useCarga(async () => {
    const { data } = await supabase.from('cafs').select('*').eq('empresa_id', empresa.id).order('tipo_dte').order('folio_desde');
    return data ?? [];
  }, [empresa.id]);
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);

  async function subir(f: File | undefined) {
    if (!f) return;
    setMsg(null);
    try {
      const xml = await leerArchivo(f, 'latin1');
      const r = await llamarFuncion('credenciales', { empresaId: empresa.id, accion: 'caf', xml });
      setMsg({ tipo: 'ok', txt: `CAF cargado: ${NOMBRE_DTE[r.tipo_dte]} folios ${r.folio_desde} a ${r.folio_hasta}` });
      recargar();
    } catch (e) {
      setMsg({ tipo: 'error', txt: (e as Error).message });
    }
  }

  return (
    <Tarjeta titulo="Folios autorizados (CAF)" extra={puede('admin') && <label className="btn btn-secundario">Cargar CAF<input type="file" accept=".xml" hidden onChange={(e) => { subir(e.target.files?.[0]); e.target.value = ''; }} /></label>}>
      {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
      {!datos?.length ? <p className="sub">Descargue los CAF desde sii.cl (Factura electrónica → Timbraje electrónico) y cárguelos aquí.</p> : (
        <table className="tabla compacta">
          <thead><tr><th>Tipo</th><th>Rango</th><th className="num">Disponibles</th><th>Autorizado</th></tr></thead>
          <tbody>{datos.map((c: any) => {
            const disp = c.folio_hasta - c.folio_siguiente + 1;
            return (
              <tr key={c.id}><td>{NOMBRE_DTE[c.tipo_dte] ?? c.tipo_dte}</td><td className="mono">{c.folio_desde}–{c.folio_hasta}</td><td className={`num ${disp < 10 ? 'error-txt' : ''}`}>{disp}</td><td>{fecha(c.fecha_autorizacion)}</td></tr>
            );
          })}</tbody>
        </table>
      )}
    </Tarjeta>
  );
}

function Usuarios() {
  const empresa = useEmpresa();
  const { puede, session } = useSesion();
  const { datos, recargar } = useCarga(async () => {
    const { data } = await supabase.from('miembros').select('user_id, rol, creado_en').eq('empresa_id', empresa.id);
    const ids = (data ?? []).map((m) => m.user_id);
    const { data: perfiles } = await supabase.from('perfiles').select('id, nombre').in('id', ids);
    return (data ?? []).map((m) => ({ ...m, nombre: perfiles?.find((p) => p.id === m.user_id)?.nombre ?? m.user_id }));
  }, [empresa.id]);
  const [correo, setCorreo] = useState('');
  const [rol, setRol] = useState<Rol>('contador');
  const [msg, setMsg] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);

  async function agregar(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    try {
      await rpc('agregar_miembro', { p_empresa: empresa.id, p_correo: correo, p_rol: rol });
      setCorreo('');
      setMsg({ tipo: 'ok', txt: 'Usuario agregado' });
      recargar();
    } catch (e) {
      setMsg({ tipo: 'error', txt: (e as Error).message });
    }
  }
  async function cambiar(userId: string, nuevo: string) {
    setMsg(null);
    const { error } = nuevo === 'quitar'
      ? await supabase.from('miembros').delete().eq('empresa_id', empresa.id).eq('user_id', userId)
      : await supabase.from('miembros').update({ rol: nuevo }).eq('empresa_id', empresa.id).eq('user_id', userId);
    if (error) setMsg({ tipo: 'error', txt: error.message });
    recargar();
  }

  return (
    <Tarjeta titulo="Usuarios y roles">
      <table className="tabla compacta">
        <thead><tr><th>Usuario</th><th>Rol</th><th>Desde</th></tr></thead>
        <tbody>{(datos ?? []).map((m: any) => (
          <tr key={m.user_id}>
            <td>{m.nombre}{m.user_id === session?.user.id && <span className="sub"> (tú)</span>}</td>
            <td>{puede('admin') ? (
              <Selector value={m.rol} onChange={(e) => cambiar(m.user_id, e.target.value)}>
                {['admin', 'contador', 'operador', 'auditor', 'lector'].map((r) => <option key={r} value={r}>{r}</option>)}
                <option value="quitar">— quitar acceso —</option>
              </Selector>
            ) : m.rol}</td>
            <td>{fechaHora(m.creado_en)}</td>
          </tr>
        ))}</tbody>
      </table>
      <p className="sub pequeno"><b>admin</b>: todo · <b>contador</b>: contabiliza, emite, acepta/reclama, F29 · <b>operador</b>: borradores, emite, importa · <b>auditor</b>: lectura + bitácora · <b>lector</b>: solo lectura</p>
      {puede('admin') && (
        <form onSubmit={agregar} className="fila-form">
          <Campo etiqueta="Correo (debe tener cuenta en Cuadra)"><Entrada type="email" value={correo} onChange={(e) => setCorreo(e.target.value)} required /></Campo>
          <Campo etiqueta="Rol"><Selector value={rol} onChange={(e) => setRol(e.target.value as Rol)}>{['admin', 'contador', 'operador', 'auditor', 'lector'].map((r) => <option key={r}>{r}</option>)}</Selector></Campo>
          <Boton type="submit">Agregar</Boton>
        </form>
      )}
      {msg && <Aviso tipo={msg.tipo}>{msg.txt}</Aviso>}
    </Tarjeta>
  );
}

const AUTO: [string, string][] = [
  ['cuenta_clientes', 'Clientes'], ['cuenta_proveedores', 'Proveedores'], ['cuenta_ventas', 'Ventas afectas'], ['cuenta_ventas_exentas', 'Ventas exentas'],
  ['cuenta_iva_debito', 'IVA débito fiscal'], ['cuenta_iva_credito', 'IVA crédito fiscal'], ['cuenta_gasto_defecto', 'Gasto por defecto (compras)'], ['cuenta_iva_no_recuperable', 'IVA no recuperable'],
];

function CuentasAutomaticas() {
  const empresa = useEmpresa();
  const { datos } = useCarga(async () => {
    const [plan, { data: conf }] = await Promise.all([cuentas(empresa.id), supabase.from('configuracion_cuentas').select('*').eq('empresa_id', empresa.id).maybeSingle()]);
    return { plan: plan.filter((c) => c.imputable), conf: conf ?? {} };
  }, [empresa.id]);
  const [msg, setMsg] = useState('');
  if (!datos) return <Tarjeta titulo="Cuentas para asientos automáticos"><Cargando /></Tarjeta>;
  async function cambiar(k: string, v: string) {
    const { error } = await supabase.from('configuracion_cuentas').update({ [k]: v || null }).eq('empresa_id', empresa.id);
    setMsg(error ? error.message : 'Guardado');
  }
  return (
    <Tarjeta titulo="Cuentas para asientos automáticos">
      <div className="grid-2 form">
        {AUTO.map(([k, t]) => (
          <Campo key={k} etiqueta={t}>
            <Selector defaultValue={(datos.conf as any)[k] ?? ''} onChange={(e) => cambiar(k, e.target.value)}>
              <option value="">—</option>
              {datos.plan.map((c) => <option key={c.id} value={c.id}>{c.codigo} {c.nombre}</option>)}
            </Selector>
          </Campo>
        ))}
      </div>
      {msg && <p className="sub pequeno">{msg}</p>}
    </Tarjeta>
  );
}

function CentrosCosto() {
  const empresa = useEmpresa();
  const { datos, recargar } = useCarga(async () => (await supabase.from('centros_costo').select('*').eq('empresa_id', empresa.id).order('codigo')).data ?? [], [empresa.id]);
  const [cod, setCod] = useState('');
  const [nom, setNom] = useState('');
  const [err, setErr] = useState('');
  async function agregar(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.from('centros_costo').insert({ empresa_id: empresa.id, codigo: cod, nombre: nom });
    setErr(error?.message ?? '');
    if (!error) { setCod(''); setNom(''); recargar(); }
  }
  return (
    <Tarjeta titulo="Centros de costo">
      {datos?.length ? <ul className="lista">{datos.map((c: any) => <li key={c.id}><span className="mono">{c.codigo}</span> {c.nombre}</li>)}</ul> : <p className="sub">Opcional: para analizar gastos por sucursal, área o proyecto.</p>}
      <form onSubmit={agregar} className="fila-form">
        <Campo etiqueta="Código"><Entrada value={cod} onChange={(e) => setCod(e.target.value)} required /></Campo>
        <Campo etiqueta="Nombre"><Entrada value={nom} onChange={(e) => setNom(e.target.value)} required /></Campo>
        <Boton type="submit" variante="secundario">Agregar</Boton>
      </form>
      {err && <Aviso tipo="error">{err}</Aviso>}
    </Tarjeta>
  );
}
