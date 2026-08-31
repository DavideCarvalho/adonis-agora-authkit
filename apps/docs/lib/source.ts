import { loader } from 'fumadocs-core/source';
import * as lucide from 'lucide-react';
import { type ComponentType, createElement } from 'react';
import { docs } from '@/.source/server';

export const source = loader({
  baseUrl: '/docs',
  source: docs.toFumadocsSource(),
  icon(name) {
    if (!name) return;
    const Icon = (lucide as Record<string, unknown>)[name];
    if (Icon) return createElement(Icon as ComponentType);
  },
});
