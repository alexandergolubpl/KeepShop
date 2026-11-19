// Ассоциативные связи между товарами: «С этим часто берут».
// Источники (вес):
//   1) ваша история покупок — товары, купленные в один день (самый сильный и растёт со временем);
//   2) ручные связи из базы товаров (product.links);
//   3) рецепты — ингредиенты одного блюда;
//   4) встроенные типичные пары (паста → пармезан, чипсы → газировка…);
//   5) списки — слабый сигнал, тем слабее, чем длиннее список (в списке из 300 позиций «вместе» всё подряд).
import { normName } from './price-hints';

export type Reason = 'history' | 'manual' | 'recipe' | 'typical' | 'list';
export interface Suggestion { name: string; score: number; reason: Reason }

interface Sources {
  /** история покупок: { name, date } */
  history: { name: string; date?: string }[];
  /** списки: массивы названий */
  lists: string[][];
  /** рецепты: массивы ингредиентов */
  recipes: string[][];
  /** ручные связи: пары названий */
  manual: [string, string][];
}

// Типичные наборы: товары внутри группы связаны между собой
const TYPICAL: string[][] = [
  ['Спагетти', 'Пармезан', 'Фарш', 'Томатная паста', 'Чеснок'],
  ['Макароны', 'Сыр', 'Фарш', 'Кетчуп'],
  ['Хлеб', 'Масло сливочное', 'Сыр', 'Ветчина', 'Колбаса'],
  ['Батон', 'Масло сливочное', 'Сыр'],
  ['Чипсы', 'Газировка', 'Пиво', 'Орехи'],
  ['Пиво', 'Чипсы', 'Орехи', 'Сухарики'],
  ['Кофе', 'Молоко', 'Сливки', 'Сахар'],
  ['Чай', 'Лимоны', 'Мёд', 'Печенье', 'Сахар'],
  ['Пельмени', 'Сметана', 'Майонез'],
  ['Вареники', 'Сметана'],
  ['Картофель', 'Лук', 'Морковь', 'Масло подсолнечное'],
  ['Помидоры', 'Огурцы', 'Лук', 'Сметана', 'Зелень'],
  ['Салат', 'Помидоры', 'Огурцы', 'Масло оливковое'],
  ['Яйца', 'Молоко', 'Бекон', 'Хлеб'],
  ['Мука', 'Яйца', 'Сахар', 'Молоко', 'Разрыхлитель', 'Масло сливочное'],
  ['Творог', 'Сметана', 'Яйца', 'Мука', 'Сахар'],
  ['Овсянка', 'Молоко', 'Бананы', 'Мёд', 'Ягоды'],
  ['Мюсли', 'Йогурт', 'Молоко'],
  ['Куриное филе', 'Рис', 'Соевый соус', 'Чеснок'],
  ['Куриные бёдра', 'Картофель', 'Паприка', 'Чеснок'],
  ['Фарш', 'Лук', 'Яйца', 'Хлеб'],
  ['Свинина', 'Лук', 'Картофель'],
  ['Говядина', 'Лук', 'Морковь', 'Картофель'],
  ['Лосось', 'Лимоны', 'Рис', 'Брокколи'],
  ['Пицца', 'Газировка'],
  ['Сосиски', 'Кетчуп', 'Горчица', 'Булочки'],
  ['Тортильи', 'Фарш', 'Сыр', 'Помидоры', 'Салат'],
  ['Моцарелла', 'Помидоры', 'Масло оливковое'],
  ['Сыр творожный', 'Хлеб', 'Сельдь'],
  ['Мороженое', 'Ягоды'],
  ['Вино', 'Сыр', 'Виноград'],
  ['Средство для посуды', 'Губки'],
  ['Стиральный порошок', 'Мусорные пакеты'],
  ['Туалетная бумага', 'Бумажные полотенца'],
  ['Зубная паста', 'Зубная щётка'],
  ['Шампунь', 'Гель для душа'],
  ['Корм для кошек', 'Наполнитель'],
];

const WEIGHT: Record<Reason, number> = { history: 3, manual: 5, recipe: 1.2, typical: 1.5, list: 1 };
const key = (s: string) => normName(s);

export class AssociationIndex {
  private edges = new Map<string, Map<string, { score: number; reason: Reason; reasonScore: number }>>();
  private display = new Map<string, string>(); // ключ → «красивое» название

  constructor(src: Sources) {
    const addName = (n: string) => { const k = key(n); if (k && !this.display.has(k)) this.display.set(k, n.trim()); return k; };
    const link = (a: string, b: string, w: number, reason: Reason) => {
      if (!a || !b || a === b || w <= 0) return;
      for (const [x, y] of [[a, b], [b, a]]) {
        let m = this.edges.get(x);
        if (!m) this.edges.set(x, (m = new Map()));
        const e = m.get(y) || { score: 0, reason, reasonScore: 0 };
        e.score += w;
        // причина — источник с наибольшим вкладом
        const contrib = w;
        if (contrib > e.reasonScore) { e.reason = reason; e.reasonScore = contrib; }
        m.set(y, e);
      }
    };
    const group = (names: string[], w: number, reason: Reason) => {
      const ks = [...new Set(names.map(addName).filter(Boolean))];
      for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) link(ks[i], ks[j], w, reason);
    };

    // 1) история: покупки одного дня = одна поездка в магазин
    const trips = new Map<string, string[]>();
    src.history.forEach(h => { if (h.date) trips.set(h.date, [...(trips.get(h.date) || []), h.name]); });
    trips.forEach(names => { if (names.length > 1 && names.length <= 60) group(names, WEIGHT.history, 'history'); });
    // 2) ручные связи
    src.manual.forEach(([a, b]) => link(addName(a), addName(b), WEIGHT.manual, 'manual'));
    // 3) рецепты
    src.recipes.forEach(r => group(r, WEIGHT.recipe, 'recipe'));
    // 4) типичные наборы
    TYPICAL.forEach(g => group(g, WEIGHT.typical, 'typical'));
    // 5) списки: вес ~ 1/(размер-1), длинные списки почти не влияют
    src.lists.forEach(l => { if (l.length > 1 && l.length <= 80) group(l, WEIGHT.list * 2 / (l.length - 1), 'list'); });
  }

  /** Связанные товары для `name`, кроме exclude (ключи normName), лучшие первыми. */
  suggest(name: string, exclude: Set<string> = new Set(), limit = 6): Suggestion[] {
    const k = key(name);
    let m = this.edges.get(k);
    if (!m) {
      // «Молоко 3.2%» → связи «Молоко»: ищем самый длинный известный ключ в начале названия
      const prefix = [...this.edges.keys()].filter(x => k.startsWith(x + ' ')).sort((a, b) => b.length - a.length)[0];
      m = prefix ? this.edges.get(prefix) : undefined;
    }
    if (!m) return [];
    return [...m.entries()]
      .filter(([x, e]) => !exclude.has(x) && x !== k && e.score >= 0.3)
      .sort((a, b) => b[1].score - a[1].score)
      .slice(0, limit)
      .map(([x, e]) => ({ name: this.display.get(x) || x, score: Math.round(e.score * 10) / 10, reason: e.reason }));
  }
}

export const REASON_LABEL: Record<Reason, string> = {
  history: 'вы покупали вместе', manual: 'ваша связь', recipe: 'в рецептах', typical: 'обычно берут вместе', list: 'в ваших списках',
};
