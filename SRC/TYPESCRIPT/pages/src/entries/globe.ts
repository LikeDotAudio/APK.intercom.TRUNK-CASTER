// Globe page (html.rs globe_page): the only page script besides the map
// engine (agent 02) is the discovery tree — `<script>{disc}</script>`.
import { initDiscovery } from '../lib/discovery.ts';

initDiscovery();
