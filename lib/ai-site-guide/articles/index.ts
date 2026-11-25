import type { SiteArticle } from "../types"
import { BUYING_ARTICLES } from "./buying"
import { MONEY_ARTICLES } from "./money"
import { SHOP_ARTICLES } from "./shops"

export const ARTICLES: SiteArticle[] = [...BUYING_ARTICLES, ...MONEY_ARTICLES, ...SHOP_ARTICLES]
