import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../auth/AuthProvider';
import { Layout } from '../components/Layout';
import { GuestOnly, RequireRole } from '../components/RouteGuards';
import { AccountsPage } from '../pages/AccountsPage';
import { AdminAccountsPage } from '../pages/AdminAccountsPage';
import { AdminAuditPage } from '../pages/AdminAuditPage';
import { AdminDashboardPage } from '../pages/AdminDashboardPage';
import { AdminOnboardingPage } from '../pages/AdminOnboardingPage';
import { AdminUsersPage } from '../pages/AdminUsersPage';
import { CustomerDashboardPage } from '../pages/CustomerDashboardPage';
import { CustomerOnboardingPage } from '../pages/CustomerOnboardingPage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { OverviewPage } from '../pages/OverviewPage';
import { RegisterPage } from '../pages/RegisterPage';

export function AppRoutes() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<OverviewPage />} />

        <Route element={<GuestOnly />}>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/register" element={<RegisterPage />} />
        </Route>

        <Route element={<RequireRole allowedRoles={['CUSTOMER']} />}>
          <Route path="/customer" element={<CustomerDashboardPage />} />
          <Route path="/onboarding" element={<CustomerOnboardingPage />} />
          <Route path="/accounts" element={<AccountsPage />} />
        </Route>

        <Route element={<RequireRole allowedRoles={['ADMIN', 'SUPER_ADMIN']} />}>
          <Route path="/admin" element={<AdminDashboardPage />} />
          <Route path="/admin/onboarding" element={<AdminOnboardingPage />} />
          <Route path="/admin/accounts" element={<AdminAccountsPage />} />
          <Route path="/admin/users" element={<AdminUsersPage />} />
          <Route path="/admin/audit" element={<AdminAuditPage />} />
        </Route>

        <Route path="*" element={<NotFoundPage />} />
      </Routes>
    </Layout>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppRoutes />
      </AuthProvider>
    </BrowserRouter>
  );
}
