import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';

/**
 * `defaultMdxComponents` only covers Card/Cards/Callout and the element
 * overrides. Steps, Tabs and Accordions ship as separate entrypoints, so a page
 * using them renders fine in the editor and then throws "Expected component
 * `Steps` to be defined" at build time. Registering them here is what makes them
 * usable from any page without a per-page import.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    Accordion,
    Accordions,
    Step,
    Steps,
    Tab,
    Tabs,
    ...components,
  };
}
