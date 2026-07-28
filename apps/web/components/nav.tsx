import Link from 'next/link';
import { auth, signOut } from '../auth';

/**
 * Server component: it reads the session directly rather than fetching it, so
 * the first paint already knows who is signed in and the nav never flickers
 * from logged-out to logged-in.
 */
export async function Nav() {
  const session = await auth();
  const role = session?.user.role;

  return (
    <nav className="nav">
      <Link href="/" className="brand">
        LMS
      </Link>
      <div className="links">
        <Link href="/">Catalog</Link>
        {session ? <Link href="/my/courses">My courses</Link> : null}
        {role === 'INSTRUCTOR' || role === 'ADMIN' ? (
          <Link href="/instructor">Instructor</Link>
        ) : null}
        {role === 'ADMIN' ? <Link href="/admin">Admin</Link> : null}
        {session ? (
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/' });
            }}
          >
            <button type="submit" className="btn" data-testid="sign-out">
              Sign out
            </button>
          </form>
        ) : (
          <>
            <Link href="/login">Sign in</Link>
            <Link href="/signup">Sign up</Link>
          </>
        )}
      </div>
    </nav>
  );
}
