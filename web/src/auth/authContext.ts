import { createContext } from 'react';
import type { AuthUser } from '../lib/types';

export interface AuthContextValue {
  user: AuthUser | null;
  isBootstrapping: boolean;
  bootstrapError: string | null;
  sessionNotice: string | null;
  login: (input: { email: string; password: string }) => Promise<AuthUser>;
  register: (input: {
    fullName: string;
    email: string;
    password: string;
  }) => Promise<AuthUser>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<AuthUser | null>;
  clearSessionNotice: () => void;
}

export const AuthContext = createContext<AuthContextValue | null>(null);
