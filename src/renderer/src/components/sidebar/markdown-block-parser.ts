import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'

export const markdownBlockParser = unified().use(remarkParse).use(remarkGfm)
