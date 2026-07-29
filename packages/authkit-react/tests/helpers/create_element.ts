import { type FunctionComponent, type ReactNode, createElement } from 'react';

/**
 * `createElement` para componentes que declaram `children` OBRIGATÓRIO.
 *
 * Por que existe. O overload de `React.createElement` cobra que o 2º argumento
 * satisfaça `P` inteiro — inclusive `children` — mesmo quando os children vão
 * na posição de varargs (que é de onde o React realmente os pega). Então
 * `createElement(CanPermission, { permission }, 'YES')` é TS2769, apesar de
 * funcionar. As duas saídas óbvias são ruins: passar `children` dentro do
 * objeto de props viola a regra `lint/correctness/noChildrenProp` do biome, e
 * um `as CanPermissionProps` no props apagaria a checagem de TODAS as outras
 * props junto.
 *
 * Aqui o cast é do TIPO DO COMPONENTE, não das props: `children` sai de `P`
 * (vai pelo canal de varargs) e todo o resto de `P` continua checado —
 * inclusive prop obrigatória faltando e prop a mais.
 */
export function createElementWithChildren<P extends { children: ReactNode }>(
  type: FunctionComponent<P>,
  props: Omit<P, 'children'>,
  ...children: ReactNode[]
) {
  return createElement(type as FunctionComponent<Omit<P, 'children'>>, props, ...children);
}
