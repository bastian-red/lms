import Link from 'next/link';
import { AuthForm } from '../../components/auth-form';
import { signupAction } from '../auth-actions';

export default function SignupPage() {
  return (
    <main className="container auth-wrap">
      <h1>Create account</h1>
      <AuthForm mode="signup" action={signupAction} />
      <p className="muted">
        Already registered? <Link href="/login">Sign in</Link>
      </p>
    </main>
  );
}
