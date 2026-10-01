import { defineMethod } from '../core'
import { collectOrcadTerminalCensus } from '../../../orcad/orcad-terminal-census'
import {
  ORCAD_TERMINAL_CENSUS_METHOD,
  OrcadTerminalCensusParamsSchema
} from '../../../../shared/orcad-terminal-census'

export const ORCAD_TERMINAL_CENSUS_METHODS = [
  defineMethod({
    name: ORCAD_TERMINAL_CENSUS_METHOD,
    params: OrcadTerminalCensusParamsSchema,
    handler: (params) => collectOrcadTerminalCensus(params.activatedAt)
  })
]
