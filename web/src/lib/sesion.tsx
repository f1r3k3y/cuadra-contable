import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export type Rol = 'admin' | 'contador' | 'operador' | 'auditor' | 'lector';

export interface Empresa {
  id: string;
  rut: string;
  razon_social: string;
  nombre_fantasia: string | null;
  giro: string;
  actecos: number[];
  direccion: string;
  comuna: string;
  ciudad: string | null;
  correo: string | null;
  telefono: string | null;
  sii_ambiente: 'certificacion' | 'produccion';
  sii_resolucion_numero: number;
  sii_resolucion_fecha: string | null;
  rut_envia: string | null;
  tasa_ppm: number;
  remanente_inicial: number;
}

interface Estado {
  session: Session | null;
  aal: 'aal1' | 'aal2' | null;
  necesitaMfa: boolean;
  cargando: boolean;
  empresas: (Empresa & { rol: Rol })[];
  empresa: (Empresa & { rol: Rol }) | null;
  elegirEmpresa: (id: string) => void;
  recargar: () => Promise<void>;
  puede: (...roles: Rol[]) => boolean;
}

const Ctx = createContext<Estado>(null as never);
export const useSesion = () => useContext(Ctx);
export const useEmpresa = () => {
  const s = useContext(Ctx);
  if (!s.empresa) throw new Error('Sin empresa seleccionada');
  return s.empresa;
};

export function ProveedorSesion({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [aal, setAal] = useState<Estado['aal']>(null);
  const [necesitaMfa, setNecesitaMfa] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [empresas, setEmpresas] = useState<Estado['empresas']>([]);
  const [empresaId, setEmpresaId] = useState<string | null>(() => {
    try {
      return localStorage.getItem('cuadra.empresa');
    } catch {
      return null;
    }
  });

  async function evaluar(s: Session | null) {
    setSession(s);
    if (!s) {
      setAal(null);
      setEmpresas([]);
      setCargando(false);
      return;
    }
    try {
      const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      setAal((data?.currentLevel as Estado['aal']) ?? 'aal1');
      setNecesitaMfa(data?.currentLevel !== 'aal2');
      if (data?.currentLevel === 'aal2') await cargarEmpresas(s.user.id);
    } catch (e) {
      console.error('No se pudo validar la sesión', e);
      setNecesitaMfa(true);
    } finally {
      setCargando(false);
    }
  }

  async function cargarEmpresas(userId: string) {
    const { data } = await supabase.from('miembros').select('rol, empresas(*)').eq('user_id', userId);
    const lista = (data ?? []).map((m: any) => ({ ...m.empresas, rol: m.rol })) as Estado['empresas'];
    lista.sort((a, b) => a.razon_social.localeCompare(b.razon_social));
    setEmpresas(lista);
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => evaluar(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setTimeout(() => evaluar(s), 0);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const empresa = empresas.find((e) => e.id === empresaId) ?? null;

  const valor: Estado = {
    session,
    aal,
    necesitaMfa,
    cargando,
    empresas,
    empresa,
    elegirEmpresa: (id) => {
      setEmpresaId(id);
      try {
        localStorage.setItem('cuadra.empresa', id);
      } catch {
        /* almacenamiento no disponible */
      }
    },
    recargar: async () => {
      if (session) await cargarEmpresas(session.user.id);
    },
    puede: (...roles) => !!empresa && roles.includes(empresa.rol),
  };
  return <Ctx.Provider value={valor}>{children}</Ctx.Provider>;
}
