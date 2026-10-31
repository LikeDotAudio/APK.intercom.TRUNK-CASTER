// Bundle entry: the drop-in replacement for the GLOBE_JS <script>.
// esbuild --bundle --format=iife wraps it, matching the original IIFE.
import { bootGlobe } from './engine.ts';

bootGlobe();
