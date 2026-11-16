import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase';
import { useSesion } from '../lib/sesion';
import { Boton, Campo, Entrada, Aviso, Tarjeta } from '../components/ui';
import { validarRut, formatearRut } from '../../../supabase/functions/_shared/sii/rut.ts';

export function NuevaEmpresa() {
  const { session, recargar, elegirEmpresa, empresas } = useSesion();
  const nav = useNavigate();
  const [f, setF] = useState({ rut: '', razon_social: '', giro: '', acteco: '', direccion: '', comuna: '', ciudad: '', correo: '' });
  const [error, setError] = useState('');
  const [cargando, setCargando] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function crear(e: FormEvent) {
    e.preventDefault();
    setError('');
    if (!validarRut(f.rut)) return setError('El RUT no es válido');
    setCargando(true);
    const { data, error } = await supabase
      .from('empresas')
      .insert({
        rut: f.rut,
        razon_social: f.razon_social.trim(),
        giro: f.giro.trim(),
        actecos: f.acteco ? f.acteco.split(/[,\s]+/).filter(Boolean).map(Number) : [],
        direccion: f.direccion,
        comuna: f.comuna,
        ciudad: f.ciudad || null,
        correo: f.correo || null,
        creado_por: session!.user.id,
      })
      .select('id')
      .single();
    setCargando(false);
    if (error) return setError(error.message.includes('duplicate') ? 'Esa empresa ya está registrada' : error.message);
    await recargar();
    elegirEmpresa(data.id);
    nav('/configuracion');
  }

  return (
    <div className="centrado">
      <Tarjeta titulo={empresas.length ? 'Agregar empresa' : 'Registra tu primera empresa'} className="ancho-form">
        <p className="sub">Se crea con un plan de cuentas base para PYME chilena, que puedes ajustar después. Quedas como administrador.</p>
        <form onSubmit={crear} className="form grid-2">
          <Campo etiqueta="RUT empresa">
            <Entrada value={f.rut} onChange={set('rut')} onBlur={() => validarRut(f.rut) && setF({ ...f, rut: formatearRut(f.rut) })} placeholder="76.123.456-7" required />
          </Campo>
          <Campo etiqueta="Razón social"><Entrada value={f.razon_social} onChange={set('razon_social')} required /></Campo>
          <Campo etiqueta="Giro"><Entrada value={f.giro} onChange={set('giro')} required maxLength={80} /></Campo>
          <Campo etiqueta="Código de actividad (SII)" ayuda="Ej. 620200. Varios separados por coma."><Entrada value={f.acteco} onChange={set('acteco')} /></Campo>
          <Campo etiqueta="Dirección"><Entrada value={f.direccion} onChange={set('direccion')} required /></Campo>
          <Campo etiqueta="Comuna"><Entrada value={f.comuna} onChange={set('comuna')} required /></Campo>
          <Campo etiqueta="Ciudad"><Entrada value={f.ciudad} onChange={set('ciudad')} /></Campo>
          <Campo etiqueta="Correo de intercambio DTE"><Entrada type="email" value={f.correo} onChange={set('correo')} /></Campo>
          <div className="span-2">
            <Aviso tipo="error">{error}</Aviso>
            <Boton type="submit" cargando={cargando}>Crear empresa</Boton>
          </div>
        </form>
      </Tarjeta>
    </div>
  );
}
