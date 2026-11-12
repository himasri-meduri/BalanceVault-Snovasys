import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi } from '../lib/api';
import {
  ApiClientError,
  setCsrfToken,
  setUnauthorizedHandler,
} from '../lib/apiClient';
import type { AuthUser } from '../lib/types';
import { AuthContext } from './authContext';

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isBootstrapping, setIsBootstrapping] = useState(true);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      setUser(null);
      setCsrfToken(null);
      setSessionNotice('Your session expired or was revoked. Please sign in again.');
    });

    return () => {
      setUnauthorizedHandler(null);
    };
  }, []);

  const refreshSession = useCallback(async (): Promise<AuthUser | null> => {
    try {
      const res = await authApi.me({ skipUnauthorizedCallback: true });
      setCsrfToken(res.csrfToken);
      setUser(res.user);
      setBootstrapError(null);
      return res.user;
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setCsrfToken(null);
        setUser(null);
        setBootstrapError(null);
        return null;
      }

      setBootstrapError(
        err instanceof Error ? err.message : 'Unable to verify active session.',
      );
      return null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const bootstrap = async () => {
      setIsBootstrapping(true);
      try {
        const res = await authApi.me({ skipUnauthorizedCallback: true });
        if (!mounted) return;
        setCsrfToken(res.csrfToken);
        setUser(res.user);
        setBootstrapError(null);
      } catch (err) {
        if (!mounted) return;
        setCsrfToken(null);
        setUser(null);
        if (err instanceof ApiClientError && err.status === 401) {
          setBootstrapError(null);
        } else {
          setBootstrapError(
            err instanceof Error ? err.message : 'Unable to verify active session.',
          );
        }
      } finally {
        if (mounted) {
          setIsBootstrapping(false);
        }
      }
    };

    void bootstrap();

    return () => {
      mounted = false;
    };
  }, []);

  const login = useCallback(
    async (input: { email: string; password: string }): Promise<AuthUser> => {
      const res = await authApi.login(input);
      setCsrfToken(res.csrfToken);
      setUser(res.user);
      setBootstrapError(null);
      setSessionNotice(null);
      return res.user;
    },
    [],
  );

  const register = useCallback(
    async (input: {
      fullName: string;
      email: string;
      password: string;
    }): Promise<AuthUser> => {
      const res = await authApi.register(input);
      setCsrfToken(res.csrfToken);
      setUser(res.user);
      setBootstrapError(null);
      setSessionNotice(null);
      return res.user;
    },
    [],
  );

  const logout = useCallback(async (): Promise<void> => {
    try {
      await authApi.logout();
      setCsrfToken(null);
      setUser(null);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 401) {
        setCsrfToken(null);
        setUser(null);
        return;
      }
      if (
        err instanceof ApiClientError &&
        err.status === 403 &&
        err.code === 'CSRF_INVALID'
      ) {
        const current = await refreshSession();
        if (!current) {
          return;
        }
        await authApi.logout();
        setCsrfToken(null);
        setUser(null);
        return;
      }
      throw err;
    }
  }, [refreshSession]);

  const clearSessionNotice = useCallback(() => {
    setSessionNotice(null);
  }, []);

  const value = useMemo(
    () => ({
      user,
      isBootstrapping,
      bootstrapError,
      sessionNotice,
      login,
      register,
      logout,
      refreshSession,
      clearSessionNotice,
    }),
    [
      user,
      isBootstrapping,
      bootstrapError,
      sessionNotice,
      login,
      register,
      logout,
      refreshSession,
      clearSessionNotice,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
