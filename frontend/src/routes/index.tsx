import type { RouteObject } from 'react-router';
import { AuthProvider } from '../auth/AuthContext';
import { RequireAuth } from '../auth/RequireAuth';
import { AppLayout } from '../components/layout/AppLayout';
import { ToastProvider } from '../components/ui/ToastProvider';
import { RequireRole } from '../auth/RequireRole';
import { ApprovalsPage } from '../features/approvals/ApprovalsPage';
import { PeriodsPage } from '../features/periods/PeriodsPage';
import { ProjectsPage } from '../features/projects/ProjectsPage';
import { BudgetReportPage } from '../features/reports/BudgetReportPage';
import { ReportsPage } from '../features/reports/ReportsPage';
import { ReviewPage } from '../features/approvals/ReviewPage';
import { AccountPage } from '../features/account/AccountPage';
import { UsersPage } from '../features/users/UsersPage';
import { TimesheetPage } from '../features/timesheet/TimesheetPage';
import { HomePage } from '../pages/HomePage';
import { LoginPage } from '../pages/LoginPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { RouteErrorPage } from '../pages/RouteErrorPage';
import { StatusPage } from '../pages/StatusPage';

/** One route table, shared by the browser router (main.tsx) and the in-memory router (tests). */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: (
      <ToastProvider>
        <AuthProvider>
          <AppLayout />
        </AuthProvider>
      </ToastProvider>
    ),
    errorElement: <RouteErrorPage />,
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'status', element: <StatusPage /> },
      {
        element: <RequireAuth />,
        children: [
          { index: true, element: <HomePage /> },
          { path: 'timesheet', element: <TimesheetPage /> },
          { path: 'account', element: <AccountPage /> },
          { path: 'projects', element: <ProjectsPage /> },
          { path: 'reports', element: <ReportsPage /> },
          {
            element: <RequireRole area="budgets" />,
            children: [{ path: 'reports/budgets', element: <BudgetReportPage /> }],
          },
          {
            element: <RequireRole area="periods" />,
            children: [{ path: 'periods', element: <PeriodsPage /> }],
          },
          {
            element: <RequireRole area="users" />,
            children: [{ path: 'users', element: <UsersPage /> }],
          },
          {
            element: <RequireRole area="approvals" />,
            children: [
              { path: 'approvals', element: <ApprovalsPage /> },
              { path: 'approvals/:submissionId', element: <ReviewPage /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
