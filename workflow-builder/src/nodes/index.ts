// Side-effect import: each module calls registerNode() at module-load.
// Importing this barrel populates the registry before App renders.
import './triggers';
import './logic';
import './argus';
import './more';

export { getAllNodeDefinitions, getNodesByCategory, getNodeTypes, getNodeDefinition } from './registry';
