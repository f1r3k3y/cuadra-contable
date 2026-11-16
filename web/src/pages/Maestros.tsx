// Plan de cuentas y auxiliares (clientes / proveedores).
import { useState, type FormEvent } from 'react';
import { supabase } from '../lib/supabase';
import { useEmpresa, useSesion } from '../lib/sesion';
import { cuentas, auxiliares, type Cuenta, type Auxiliar } from '../lib/maestros';
import { csv } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Entrada, Selector, Modal, Aviso, Cargando, useCarga } from '../components/ui';
import { validarRut, formatearRut, rutSii } from '../../../supabase/functions/_shared/sii/rut.ts';

const CLASIF = ['activo_corriente', 'activo_no_corriente', 'pasivo_corriente', 'pasivo_no_corriente', 'patrimonio', 'ingreso_operacional', 'costo_venta', 'gasto_operacional', 'ingreso_no_operacional', 'gasto_no_operacional', 'impuesto_renta'];
const tipoDe = (codigo: string) => ({ '1': 'activo', '2': 'pasivo', '3': 'patrimonio', '4': 'ingreso', '5': 'gasto' } as Record<string, string>)[codigo[0]] ?? 'orden';

export function PlanCuentas() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const { datos, cargando, recargar } = useCarga(() => cuentas(empresa.id), [empresa.id]);
  const [edit, setEdit] = useState<Partial<Cuenta> | null>(null);
  const [buscar, setBuscar] = useState('');
  const [error, setError] = useState('');
  const editable = puede('admin', 'contador');

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!edit?.codigo || !edit.nombre) return setError('Código y nombre son obligatorios');
    const padre = (datos ?? []).find((c) => c.codigo === edit.codigo!.split('.').slice(0, -1).join('.'));
    const fila = {
      empresa_id: empresa.id, codigo: edit.codigo, nombre: edit.nombre, tipo: tipoDe(edit.codigo),
      clasificacion: edit.clasificacion || padre?.clasificacion || null, padre_id: padre?.id ?? null,
      imputable: edit.imputable ?? true, requiere_auxiliar: !!edit.requiere_auxiliar, requiere_centro_costo: !!edit.requiere_centro_costo,
      es_efectivo: !!edit.es_efectivo, activa: edit.activa ?? true,
    };
    const { error } = edit.id ? await supabase.from('cuentas').update(fila).eq('id', edit.id) : await supabase.from('cuentas').insert(fila);
    if (error) return setError(error.message.includes('duplicate') ? 'Ya existe una cuenta con ese código' : error.message);
    if (padre?.imputable && !edit.id) await supabase.from('cuentas').update({ imputable: false }).eq('id', padre.id);
    setEdit(null);
    recargar();
  }

  const lista = (datos ?? []).filter((c) => !buscar || `${c.codigo} ${c.nombre}`.toLowerCase().includes(buscar.toLowerCase()));
  return (
    <Pagina titulo="Plan de cuentas" sub="Estructura jerárquica por códigos (1 activo, 2 pasivo, 3 patrimonio, 4 ingresos, 5 costos y gastos). Solo las cuentas de último nivel reciben movimientos."
      acciones={<>
        <Boton variante="secundario" onClick={() => csv('plan_de_cuentas.csv', (datos ?? []).map(({ codigo, nombre, tipo, clasificacion, imputable }) => ({ codigo, nombre, tipo, clasificacion, imputable })))}>Exportar CSV</Boton>
        {editable && <Boton onClick={() => setEdit({ imputable: true, activa: true })}>Nueva cuenta</Boton>}
      </>}>
      <div className="filtros"><Campo etiqueta="Buscar"><Entrada value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="Código o nombre" /></Campo></div>
      <Tarjeta>
        {cargando ? <Cargando /> : (
          <table className="tabla compacta">
            <thead><tr><th>Código</th><th>Nombre</th><th>Clasificación</th><th>Atributos</th></tr></thead>
            <tbody>
              {lista.map((c) => (
                <tr key={c.id} className={`${editable ? 'clic' : ''} ${c.imputable ? '' : 'grupo'} ${c.activa ? '' : 'inactiva'}`} onClick={() => editable && setEdit(c)}>
                  <td className="mono" style={{ paddingLeft: 8 + (c.nivel - 1) * 14 }}>{c.codigo}</td>
                  <td>{c.nombre}</td>
                  <td className="sub">{c.clasificacion?.replace(/_/g, ' ')}</td>
                  <td className="sub">{[c.requiere_auxiliar && 'auxiliar', c.requiere_centro_costo && 'centro de costo', c.es_efectivo && 'efectivo', !c.activa && 'inactiva'].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Tarjeta>
      <Modal abierto={!!edit} titulo={edit?.id ? 'Editar cuenta' : 'Nueva cuenta'} onCerrar={() => setEdit(null)}>
        {edit && (
          <form onSubmit={guardar} className="form">
            <div className="grid-2">
              <Campo etiqueta="Código" ayuda="Ej. 5.2.10"><Entrada value={edit.codigo ?? ''} onChange={(e) => setEdit({ ...edit, codigo: e.target.value })} disabled={!!edit.id} /></Campo>
              <Campo etiqueta="Nombre"><Entrada value={edit.nombre ?? ''} onChange={(e) => setEdit({ ...edit, nombre: e.target.value })} /></Campo>
            </div>
            <Campo etiqueta="Clasificación (para estados y métricas)">
              <Selector value={edit.clasificacion ?? ''} onChange={(e) => setEdit({ ...edit, clasificacion: e.target.value || null })}>
                <option value="">Heredar de la cuenta padre</option>
                {CLASIF.map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
              </Selector>
            </Campo>
            <div className="checks">
              {([['imputable', 'Imputable (recibe movimientos)'], ['requiere_auxiliar', 'Exige auxiliar (cliente/proveedor)'], ['requiere_centro_costo', 'Exige centro de costo'], ['es_efectivo', 'Es efectivo (flujo de caja)'], ['activa', 'Activa']] as [keyof Cuenta, string][]).map(([k, t]) => (
                <label key={k}><input type="checkbox" checked={!!edit[k]} onChange={(e) => setEdit({ ...edit, [k]: e.target.checked })} /> {t}</label>
              ))}
            </div>
            <Aviso tipo="error">{error}</Aviso>
            <div className="acciones fin"><Boton type="submit">Guardar</Boton></div>
          </form>
        )}
      </Modal>
    </Pagina>
  );
}

export function Auxiliares() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const { datos, cargando, recargar } = useCarga(() => auxiliares(empresa.id), [empresa.id]);
  const [edit, setEdit] = useState<Partial<Auxiliar> | null>(null);
  const [error, setError] = useState('');
  const [buscar, setBuscar] = useState('');

  async function guardar(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!edit?.rut || !validarRut(edit.rut)) return setError('RUT inválido');
    if (!edit.razon_social) return setError('Falta la razón social');
    const fila = { ...edit, empresa_id: empresa.id, rut: rutSii(edit.rut) };
    const { error } = edit.id ? await supabase.from('auxiliares').update(fila).eq('id', edit.id) : await supabase.from('auxiliares').insert(fila);
    if (error) return setError(error.message.includes('duplicate') ? 'Ese RUT ya está registrado' : error.message);
    setEdit(null);
    recargar();
  }

  const lista = (datos ?? []).filter((a) => !buscar || `${a.rut} ${a.razon_social}`.toLowerCase().includes(buscar.toLowerCase()));
  return (
    <Pagina titulo="Clientes y proveedores" sub="Auxiliares para cuentas por cobrar y por pagar. Se crean solos al emitir o recibir documentos."
      acciones={puede('admin', 'contador', 'operador') && <Boton onClick={() => setEdit({ es_cliente: true })}>Nuevo</Boton>}>
      <div className="filtros"><Campo etiqueta="Buscar"><Entrada value={buscar} onChange={(e) => setBuscar(e.target.value)} placeholder="RUT o razón social" /></Campo></div>
      <Tarjeta>
        {cargando ? <Cargando /> : (
          <table className="tabla compacta">
            <thead><tr><th>RUT</th><th>Razón social</th><th>Giro</th><th>Comuna</th><th>Tipo</th></tr></thead>
            <tbody>
              {lista.map((a) => (
                <tr key={a.id} className="clic" onClick={() => setEdit(a)}>
                  <td className="mono">{formatearRut(a.rut)}</td><td>{a.razon_social}</td><td>{a.giro}</td><td>{a.comuna}</td>
                  <td className="sub">{[a.es_cliente && 'cliente', a.es_proveedor && 'proveedor'].filter(Boolean).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Tarjeta>
      <Modal abierto={!!edit} titulo={edit?.id ? 'Editar auxiliar' : 'Nuevo auxiliar'} onCerrar={() => setEdit(null)}>
        {edit && (
          <form onSubmit={guardar} className="form grid-2">
            <Campo etiqueta="RUT"><Entrada value={edit.rut ?? ''} onChange={(e) => setEdit({ ...edit, rut: e.target.value })} disabled={!!edit.id} /></Campo>
            <Campo etiqueta="Razón social"><Entrada value={edit.razon_social ?? ''} onChange={(e) => setEdit({ ...edit, razon_social: e.target.value })} /></Campo>
            <Campo etiqueta="Giro"><Entrada value={edit.giro ?? ''} onChange={(e) => setEdit({ ...edit, giro: e.target.value })} /></Campo>
            <Campo etiqueta="Dirección"><Entrada value={edit.direccion ?? ''} onChange={(e) => setEdit({ ...edit, direccion: e.target.value })} /></Campo>
            <Campo etiqueta="Comuna"><Entrada value={edit.comuna ?? ''} onChange={(e) => setEdit({ ...edit, comuna: e.target.value })} /></Campo>
            <Campo etiqueta="Ciudad"><Entrada value={edit.ciudad ?? ''} onChange={(e) => setEdit({ ...edit, ciudad: e.target.value })} /></Campo>
            <Campo etiqueta="Correo"><Entrada type="email" value={edit.correo ?? ''} onChange={(e) => setEdit({ ...edit, correo: e.target.value })} /></Campo>
            <Campo etiqueta="Correo intercambio DTE"><Entrada type="email" value={edit.correo_dte ?? ''} onChange={(e) => setEdit({ ...edit, correo_dte: e.target.value })} /></Campo>
            <div className="checks span-2">
              <label><input type="checkbox" checked={!!edit.es_cliente} onChange={(e) => setEdit({ ...edit, es_cliente: e.target.checked })} /> Cliente</label>
              <label><input type="checkbox" checked={!!edit.es_proveedor} onChange={(e) => setEdit({ ...edit, es_proveedor: e.target.checked })} /> Proveedor</label>
            </div>
            <div className="span-2"><Aviso tipo="error">{error}</Aviso></div>
            <div className="acciones fin span-2">{puede('admin', 'contador', 'operador') && <Boton type="submit">Guardar</Boton>}</div>
          </form>
        )}
      </Modal>
    </Pagina>
  );
}
