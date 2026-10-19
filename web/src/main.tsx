import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { clock } from './lib/clock';
import { LatencyRecorder } from './lib/latency';
import { store } from './lib/store';
import { StreamClient } from './lib/stream';
import './styles.css';

// Data first: the stream connects before React mounts, and components read whatever has arrived.
clock.start();
const latency = new LatencyRecorder({ clock, nextFrame: (cb) => store.afterFlush(cb) });
latency.start();
const stream = new StreamClient({
  store,
  onLiveDelta: (delta, receivedAt, receivedPerf) => latency.record(delta, receivedAt, receivedPerf),
});
stream.start();

import.meta.hot?.dispose(() => {
  stream.stop();
  latency.stop();
  clock.stop();
});

const root = document.getElementById('root');
if (root === null) throw new Error('index.html is missing #root');
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
