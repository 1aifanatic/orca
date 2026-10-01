// Part of the readiness census; readiness-census.test.ts documents it and how to regenerate.
import { CENSUS_AGENTS, describeSyntheticCensus } from './readiness-census-synthetic-suite'

describeSyntheticCensus(CENSUS_AGENTS.filter((agent) => agent >= 'l'))
