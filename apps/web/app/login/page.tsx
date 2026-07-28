import Link from 'next/link';
import { AuthForm } from '../../components/auth-form';
import { loginAction } from '../auth-actions';

export default function LoginPage() {
  return (
    <main className="container auth-wrap">
      <h1>Sign in</h1>
      <AuthForm mode="login" action={loginAction} />
      <p className="muted">
        No account? <Link href="/signup">Sign up</Link>
      </p>
    </main>
  );
}
