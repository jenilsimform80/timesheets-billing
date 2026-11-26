import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { Alert } from '../components/ui/Alert';
import { Button } from '../components/ui/Button';
import { PasswordField, TextField } from '../components/ui/FormControls';
import { describeError } from '../components/ui/describeError';
import { useAuth } from '../auth/useAuth';
import { useMutation } from '../hooks/useMutation';
import { useToast } from '../components/ui/toast-context';
import { fieldErrorsFrom } from '../lib/forms';
import { safeReturnPath } from '../lib/navigation';
import styles from './LoginPage.module.css';

export function LoginPage() {
  const { state, login } = useAuth();
  const location = useLocation();
  const from = safeReturnPath((location.state as { from?: unknown } | null)?.from);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const toast = useToast();
  const signIn = useMutation(login);

  if (state.status === 'authenticated') return <Navigate to={from} replace />;

  const missing = { email: email.trim() === '', password: password === '' };
  const serverFields = fieldErrorsFrom(signIn.error);

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (missing.email || missing.password) return;
    const result = await signIn.run(email.trim(), password);
    if (result.ok) toast.success('Signed in.');
  };

  return (
    <div className={styles.page}>
      <div className={styles.hero} aria-hidden="true">
        <h2>Track time. Approve fast. Bill with confidence.</h2>
        <p>Log hours against projects, submit weekly timesheets and keep billing periods locked.</p>
        <ul className={styles.points}>
          <li>
            <span className={styles.tick}>✓</span>Weekly timesheets with manager approval
          </li>
          <li>
            <span className={styles.tick}>✓</span>Locked billing periods you can trust
          </li>
          <li>
            <span className={styles.tick}>✓</span>Hours and budget reports per project
          </li>
        </ul>
      </div>
      <div className={styles.panel}>
        <section className={styles.wrapper} aria-labelledby="login-heading">
          <h1 id="login-heading">Sign in</h1>
          <p className={styles.lead}>Welcome back — enter your details to continue.</p>
          <form onSubmit={(e) => void onSubmit(e)} noValidate className={styles.form}>
            {signIn.error && Object.keys(serverFields).length === 0 && (
              <Alert variant="error">{describeError(signIn.error)}</Alert>
            )}
            <TextField
              label="Email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={
                (touched && missing.email ? 'Enter your email' : undefined) ?? serverFields['email']
              }
            />
            <PasswordField
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={
                (touched && missing.password ? 'Enter your password' : undefined) ??
                serverFields['password']
              }
            />
            <Button type="submit" disabled={signIn.running}>
              {signIn.running ? 'Signing in…' : 'Sign in'}
            </Button>
          </form>
          <p className={styles.lead}>
            Forgot your password? Ask an admin to reset it; you will choose a new one when you sign
            in.
          </p>
        </section>
      </div>
    </div>
  );
}
