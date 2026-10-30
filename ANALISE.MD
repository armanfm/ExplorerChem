# ExploreChem — Análises e gravames documentais vinculados ao lote

Documentação da melhoria desenvolvida em 26 e 27 de outubro de 2026.

## Objetivo e resultado

A melhoria acrescenta uma área **Analysis** para solicitar serviços e registrar documentos relacionados a lotes já existentes. Amostragem, análise laboratorial, guarda de amostras, auditoria e certificação passam a ter solicitações próprias, identificação da empresa responsável e provas documentais verificáveis na blockchain.

O lote mantém sua titularidade durante esse fluxo. A empresa prestadora recebe uma solicitação de serviço e acesso aos documentos compartilhados nessa solicitação. O registro documental não representa uma transferência do lote.

A implementação amplia a aplicação por meio de um contrato documental separado, integrado ao ActorRegistry e ao contrato de lotes da base E1 existente. A área Analysis concentra a nova interface e o histórico documental.

## O que foi acrescentado

| Recurso | Comportamento |
| --- | --- |
| Solicitação de serviço | O titular seleciona um lote, uma empresa prestadora e o serviço desejado. |
| Escopo privado | Instruções e anexos descrevem o trabalho solicitado e ficam vinculados à solicitação. |
| Aceite ou recusa | A empresa convidada responde à solicitação usando uma carteira autorizada. |
| Entrega documental | Após o aceite, a prestadora envia o documento e registra sua prova on-chain. |
| Histórico por lote | Os registros podem ser consultados pelo lote ao qual pertencem. |
| Revisões | Uma correção gera outro registro, preservando o anterior. |
| Revogação | O emissor pode revogar um registro; o histórico permanece disponível. |
| Certificados públicos | O arquivo do certificado é público e sua integridade pode ser verificada. |
| Encadeamento automático | O HTML busca o último registro documental válido do lote para referenciar a etapa anterior. |

## Serviços disponíveis

| Serviço na interface | Finalidade | Visibilidade do documento de resultado |
| --- | --- | --- |
| Sampling | Registrar a amostragem realizada. | Privada |
| Laboratory analysis | Vincular um laudo de análise ao lote. | Privada |
| Sample custody | Registrar a guarda ou custódia da amostra. | Privada |
| Audit | Vincular um relatório de auditoria. | Privada |
| Certification | Publicar um certificado associado ao lote. | Pública |

Cada solicitação possui seu próprio conjunto de documentos. Todos os serviços usam a mesma área Analysis e são identificados pelo tipo, pela empresa e pelo lote. A ordem dos serviços não é imposta como uma sequência obrigatória pelo contrato.

Os serviços são categorias da solicitação. A melhoria utiliza os atores já existentes e não exige uma nova classificação obrigatória no cadastro on-chain.

## Fluxo de uso

1. O titular seleciona sua empresa e um lote existente.
2. Escolhe a empresa prestadora, o serviço e as instruções, podendo anexar documentos privados.
3. A carteira autorizada do titular registra a solicitação na blockchain.
4. A prestadora seleciona sua empresa e encontra o pedido em **Received**.
5. Uma carteira autorizada da prestadora aceita ou recusa o pedido.
6. Após aceitar, a prestadora envia o resultado e confirma o registro de sua prova na MetaMask.
7. O registro passa a integrar o histórico documental daquele lote.

O solicitante pode cancelar um pedido que ainda esteja pendente. O primeiro resultado registrado conclui a solicitação; a prestadora pode acrescentar revisões posteriormente, conforme as autorizações do contrato.

O envio do arquivo e a transação on-chain são operações distintas. Um arquivo enviado ainda pode estar aguardando a confirmação da prova. A interface oferece recuperação de publicações pendentes para retomar esse processo.

## Seções da interface

| Seção | Uso |
| --- | --- |
| Request service | Criar uma solicitação de serviço para um lote. |
| Received | Consultar pedidos recebidos pela empresa selecionada, responder e entregar resultados. |
| Sent | Acompanhar os pedidos enviados pela empresa selecionada. |
| Lot history | Consultar registros documentais, revisões e revogações vinculados ao lote. |
| Public certificates | Consultar e baixar certificados públicos, verificando sua integridade. |

Os contadores de Received e Sent acompanham a empresa selecionada. Selecionar uma empresa na interface não concede autorização: as operações são verificadas pelo contrato e pelo serviço de documentos.

## Significado do gravame documental

Nesta melhoria, **gravame documental** é o registro de uma prova vinculada ao lote. Ele identifica a solicitação, o ator emissor, o tipo de serviço, o compromisso criptográfico do documento, a carteira que registrou e o momento do registro.

Esse gravame não cria bloqueio financeiro, não consome o lote e não transfere sua titularidade. Também não executa transformação de material. A custódia de amostras é um serviço documental e não equivale à titularidade do lote.

O contrato documental não chama as funções de transferência, transformação, imposição de gravame financeiro ou liberação do contrato de lotes.

## Integridade e identificação de alterações

O sistema permite verificar se o arquivo corresponde à prova registrada. A verificação usa os bytes exatos do documento baixado.

Para documentos privados, o backend calcula um compromisso com o SHA-256 do arquivo, um salt aleatório e o contexto da solicitação. O compromisso usa Keccak-256 sobre uma codificação ABI que inclui domínio, rede, contrato documental, lote, solicitação, prestadora, serviço, hash do arquivo e salt.

Para certificados públicos, o compromisso registrado é o SHA-256 do próprio arquivo, acompanhado de sua URI pública.

Ao baixar e verificar:

- Se o arquivo corresponder ao compromisso, a verificação confirma sua integridade.
- Se os bytes tiverem sido alterados, a verificação identifica a divergência.
- Mesmo uma alteração visualmente pequena, como salvar novamente um PDF, pode modificar seus bytes e seu hash.

**A prova não impede a edição de uma cópia do documento. Ela permite detectar que essa cópia difere do arquivo registrado.** Também não comprova a veracidade científica do laudo, a representatividade da amostra ou a acreditação do emissor.

Para os documentos privados, salt e hash de abertura são fornecidos somente pelo fluxo autorizado. Para os anexos do pedido, um manifesto de escopo vincula as instruções e os hashes dos arquivos ao compromisso da solicitação.

## Dados públicos e privados

| Local | Conteúdo |
| --- | --- |
| Blockchain | Identificadores do lote e da solicitação, atores envolvidos, serviço, estados, compromissos criptográficos, referências entre registros, eventos e revogações. Para certificados, também a URI pública. |
| Armazenamento privado | Instruções, anexos do pedido, resultados privados e informações necessárias para abrir e verificar os compromissos. |
| Armazenamento público de certificados | Arquivos enviados como resultados de solicitações de certificação. |

Metadados on-chain são públicos, inclusive a relação entre lote, empresas e serviço. A privacidade se aplica ao conteúdo dos arquivos privados.

O serviço de documentos utiliza autenticação Supabase e uma assinatura da carteira para verificar o acesso. Consulta as autorizações atuais do contrato antes de fornecer os documentos privados, usando URLs temporárias para download.

O acesso privado está limitado aos participantes autorizados de cada solicitação: solicitante e prestadora. Uma solicitação recusada ou cancelada deixa de conceder elegibilidade de acesso pelo contrato. A revogação de um documento sinaliza seu estado no histórico; não apaga cópias previamente baixadas nem torna privado um certificado público.

## Etapa anterior e revisões

Há duas referências diferentes:

| Referência | Significado |
| --- | --- |
| `previousStageRecordId` | Relaciona uma nova solicitação a um registro documental anterior do mesmo lote. |
| `previousRecordId` | Relaciona uma nova versão do resultado à versão anterior da mesma solicitação. |

O campo manual de etapa anterior foi retirado da interface entregue. O HTML percorre os registros do lote do mais recente para o mais antigo, ignora registros revogados e versões substituídas, e usa o primeiro registro elegível. Quando não existe registro elegível, envia a referência zero.

Essa escolha automática segue a ordem dos registros. Não representa uma validação de que uma etapa específica, como auditoria, seja obrigatória antes da certificação.

**Referenciar um documento anterior não concede acesso ao seu arquivo privado.**

## Integração técnica

Rede: Ethereum Sepolia, chain ID `11155111`.

| Contrato | Endereço |
| --- | --- |
| ExploreChemDocumentaryRegistry | `0x0D3bB1A96bBaaB2e3b1f5F06ed91F672418c1b1f` |
| ExploreChemProofRegistry da base existente | `0x1934305d8FC0a426a0eF5D475E941341d8c9fC1e` |
| ActorRegistry vinculado | `0x2fb8a06A929299fEFCAfef63fCf663C0b07016F8` |
| Contrato de lotes vinculado | `0x92eFE5Cf48d9e18d2B66F1547D3E6D445b1774a3` |

O construtor do contrato documental recebe o endereço do ProofRegistry e descobre os contratos vinculados. O registro de pedidos exige ator ativo e carteira autorizada do titular. O aceite e a entrega exigem autorização da prestadora. A revogação exige autorização do ator emissor.

O contrato permite serviços documentais em lotes nos estados aceitos pela implementação, inclusive lotes com gravame financeiro, sem liberar esse gravame.

A camada off-chain acrescenta as tabelas `explorechem_analysis_auth_v1` e `explorechem_analysis_documents_v1`, os buckets `explorechem-analysis-private-v1` e `explorechem-analysis-certificates-v1`, e a função `explorechem-analysis-v1`. As tabelas de controle são acessadas pelo backend; os arquivos privados não são expostos por leitura direta do frontend.

## Correções associadas à demonstração

Durante o teste de cadastro do TerraLab, a blockchain confirmou o registro, mas o Supabase recusou a gravação do diretório da empresa. A regra da demo rejeitava o tipo `OTHER`, utilizado pelo cadastro da base antiga.

A regra foi ajustada e o TerraLab foi salvo usando o identificador já confirmado on-chain, sem repetir as transações. Também foi alinhada a leitura do diretório público para usuários com e sem sessão, pois havia diferença entre as permissões desses dois casos.

Essas correções são do cadastro e da consulta do diretório. Elas não concedem acesso aos documentos privados das solicitações.

## Validação e limites da demo

Foram executadas 17 verificações locais de comportamento do contrato, incluindo autorização, aceite, revisões, revogação, publicidade dos certificados e preservação do estado do lote. As verificações locais da interface abrangeram as seções, ações e seleção automática da referência anterior.

Também foram verificados o cadastro recuperado do TerraLab, sua consulta pelo diretório e seu estado ativo no ActorRegistry. Essas verificações não equivalem à conclusão de todos os fluxos reais com assinatura da carteira do usuário.

A demo pode utilizar laudos fictícios, identificados como simulados, para demonstrar upload, registro da prova e verificação de integridade. O vínculo documental não executa uma nova análise química pelo CRE e não transforma o resultado em validação científica automática.

O compartilhamento dos documentos privados de etapas anteriores com uma certificadora futura ainda não está implementado. Hoje, ela acessa os arquivos compartilhados na solicitação da qual participa. Esse compartilhamento entre etapas fica como evolução posterior.

A publicação de um certificado neste contrato também não altera automaticamente a elegibilidade de um lote para RWA ou suas regras na base existente. Uma integração desse tipo precisaria ser implementada e validada separadamente.

## Arquivos da implementação documentada

- `ExploreChemDocumentaryRegistry.sol`: contrato dos pedidos e registros documentais.
- `ExploreChemDocumentaryRegistry.abi.json`: ABI utilizada pela integração.
- `analysis-extension/analysis.js`: fluxo e interface da área Analysis.
- `analysis-extension/analysis.css`: estilos da área Analysis.
- `analysis-extension/edge.ts`: autenticação de carteira, arquivos e verificação de autorização.
- `analysis-extension/storage.sql`: estrutura inicial do armazenamento documental.
- `ExploreChem-index-com-Analysis.html`: HTML completo entregue com a nova área.

Este documento descreve a versão entregue nesta conversa. Atualizações do site publicado dependem da versão de HTML efetivamente carregada pelo usuário.
