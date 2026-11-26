import type { ReactNode } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { canAccess, type Area } from '../../auth/access';
import { useAuth } from '../../auth/useAuth';
import { useMutation } from '../../hooks/useMutation';
import { Alert } from '../ui/Alert';
import { useToast } from '../ui/toast-context';
import { describeError } from '../ui/describeError';
import { ActionMenu, type ActionMenuItem } from '../ui/ActionMenu';
import styles from './AppLayout.module.css';
import {
  ChartIcon,
  CheckIcon,
  ClockIcon,
  FolderIcon,
  HomeIcon,
  KeyIcon,
  LockIcon,
  UsersIcon,
  WalletIcon,
} from './icons';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  end?: boolean;
  area?: Area;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: <HomeIcon />, end: true },
  { to: '/timesheet', label: 'Timesheet', icon: <ClockIcon />, area: 'timesheet' },
  { to: '/approvals', label: 'Approvals', icon: <CheckIcon />, area: 'approvals' },
  { to: '/projects', label: 'Projects', icon: <FolderIcon />, area: 'projects' },
  { to: '/reports', label: 'Reports', icon: <ChartIcon />, area: 'reports', end: true },
  { to: '/reports/budgets', label: 'Budgets', icon: <WalletIcon />, area: 'budgets' },
  { to: '/users', label: 'Users', icon: <UsersIcon />, area: 'users' },
  { to: '/periods', label: 'Locked periods', icon: <LockIcon />, area: 'periods' },
  { to: '/account', label: 'Account', icon: <KeyIcon />, area: 'account' },
];

const ROLE_LABEL = {
  CONTRIBUTOR: 'Contributor',
  MANAGER: 'Manager',
  ADMIN: 'Admin / Finance',
} as const;

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('');
}

export function AppLayout() {
  const { state, logout } = useAuth();
  const toast = useToast();
  const signOut = useMutation(async () => {
    await logout();
    toast.success('You have been signed out.');
  });
  const navigate = useNavigate();
  const user = state.status === 'authenticated' ? state.user : null;
  const items = user
    ? NAV_ITEMS.filter((item) =>
        user.mustChangePassword
          ? item.to === '/account'
          : !item.area || canAccess(user.role, item.area),
      )
    : [];
  const menuItems: ActionMenuItem[] = user
    ? [
        ...(canAccess(user.role, 'account')
          ? [{ label: 'Account & password', onSelect: () => void navigate('/account') }]
          : []),
        {
          label: signOut.running ? 'Signing out…' : 'Sign out',
          onSelect: () => void signOut.run(),
          disabled: signOut.running,
          tone: 'danger' as const,
        },
      ]
    : [];
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    isActive ? styles.active : styles.link;

  const signOutBanner = signOut.error && (
    <div className={styles.banner}>
      <Alert variant="error" title="Could not sign out">
        {describeError(signOut.error)} You are still signed in.
      </Alert>
    </div>
  );

  if (!user) {
    return (
      <div className={`${styles.shell} ${styles.bare}`}>
        <a href="#main" className={styles.skipLink}>
          Skip to content
        </a>
        <header className={styles.bareHeader}>
          <span className={styles.bareBrand}>
            <span className={styles.logo} aria-hidden="true">
              ⏱
            </span>
            Timesheets &amp; Billing
          </span>
          <nav aria-label="Main">
            <div className={styles.bareNav}>
              <NavLink to="/status">System status</NavLink>
              {state.status === 'anonymous' && <NavLink to="/login">Sign in</NavLink>}
            </div>
          </nav>
        </header>
        <main id="main" className={styles.content}>
          <Outlet />
        </main>
      </div>
    );
  }

  return (
    <div className={styles.shell}>
      <a href="#main" className={styles.skipLink}>
        Skip to content
      </a>
      <aside className={styles.sidebar}>
        <span className={styles.brand}>
          <span className={styles.logo} aria-hidden="true">
            ⏱
          </span>
          Timesheets &amp; Billing
        </span>
        <nav aria-label="Main">
          <ul className={styles.nav}>
            {items.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to} end={item.end ?? false} className={linkClass}>
                  {item.icon}
                  {item.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <div className={styles.content}>
        <header className={styles.topbar}>
          <ActionMenu label="Account menu" items={menuItems} triggerClassName={styles.account}>
            <span className={styles.avatar} aria-hidden="true">
              {initials(user.name)}
            </span>
            <span className={styles.who}>
              <span className={styles.name}>{user.name}</span>
              <small className={styles.role}>{ROLE_LABEL[user.role]}</small>
            </span>
            <span className={styles.chevron} aria-hidden="true">
              ▾
            </span>
          </ActionMenu>
        </header>
        {signOutBanner}
        <main id="main" className={styles.main}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
