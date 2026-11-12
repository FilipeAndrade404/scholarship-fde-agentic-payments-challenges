export type Product = {
  id: string
  nome: string
  preco_centavos: number
  moeda: 'BRL'
  estoque: number
  categoria: string
}

// Dados iniciais do catálogo da Fase 1, usados para provisionar a tabela.
export const initialCatalog: readonly Product[] = [
  { id: 'prod_001', nome: 'PlayStation 5', preco_centavos: 479900, moeda: 'BRL', estoque: 10, categoria: 'games' },
  { id: 'prod_002', nome: 'PC Gamer', preco_centavos: 1249900, moeda: 'BRL', estoque: 5, categoria: 'informatica' },
  { id: 'prod_003', nome: 'Fone Bluetooth', preco_centavos: 24990, moeda: 'BRL', estoque: 12, categoria: 'audio' },
  { id: 'prod_004', nome: 'Monitor Gamer 27" 144Hz', preco_centavos: 189990, moeda: 'BRL', estoque: 8, categoria: 'monitores' },
  { id: 'prod_005', nome: 'Cadeira Gamer Ergonômica', preco_centavos: 129900, moeda: 'BRL', estoque: 15, categoria: 'moveis' },
  { id: 'prod_006', nome: 'Mouse Sem Fio', preco_centavos: 14950, moeda: 'BRL', estoque: 25, categoria: 'perifericos' },
  { id: 'prod_007', nome: 'Teclado Mecânico RGB', preco_centavos: 29990, moeda: 'BRL', estoque: 18, categoria: 'perifericos' }
]
