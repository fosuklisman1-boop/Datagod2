import type { SiteArticle } from "../types"
import { BUYING_ARTICLES } from "./buying"
import { MONEY_ARTICLES } from "./money"

export const ARTICLES: SiteArticle[] = [...BUYING_ARTICLES, ...MONEY_ARTICLES]
