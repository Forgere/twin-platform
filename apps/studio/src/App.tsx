import { Title } from '@solidjs/meta';
import { Loading } from 'solid-js';
import { Router } from './router';
import './App.css';
import './mobile.css';

// The app root: the router and the site-wide layout live here. Pages are
// the modules under src/routes.
export default function App() {
  return (
    <Router>
      {(props) => (
        <>
          <Title>Twin Studio · 数字孪生工作台</Title>
          <Loading
            fallback={
              <main class="boot" role="status" aria-live="polite">
                加载场景中…
              </main>
            }
          >
            {props.children}
          </Loading>
        </>
      )}
    </Router>
  );
}
