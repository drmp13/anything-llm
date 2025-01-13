const { v4: uuidv4 } = require("uuid");
const { DocumentManager } = require("../DocumentManager");
const { WorkspaceChats } = require("../../models/workspaceChats");
const { getVectorDbClass, getLLMProvider } = require("../helpers");
const { writeResponseChunk } = require("../helpers/chat/responses");
const { grepAgents } = require("./agents");
const {getAgent,appendWhereClause,updateTableName} = require('../agents/mindsdb')
const jbconfig = require('../../config')

// Configuration
const tableName = 'clickhouse_analytic.sales_cube';
const companyId = 57971;
const language = 'ID';

const {
  grepCommand,
  VALID_COMMANDS,
  chatPrompt,
  recentChatHistory,
  sourceIdentifier,
} = require("./index");

const VALID_CHAT_MODE = ["chat", "query"];


async function streamChatWithWorkspace(
  response,
  workspace,
  message,
  chatMode = "chat",
  user = null,
  thread = null,
  attachments = []
) {
  const uuid = uuidv4();
  const updatedMessage = await grepCommand(message, user);

  if (Object.keys(VALID_COMMANDS).includes(updatedMessage)) {
    const data = await VALID_COMMANDS[updatedMessage](
      workspace,
      message,
      uuid,
      user,
      thread
    );
    writeResponseChunk(response, data);
    return;
  }

  // If is agent enabled chat we will exit this flow early.
  const isAgentChat = await grepAgents({
    uuid,
    response,
    message,
    user,
    workspace,
    thread,
  });

  if (isAgentChat) return;

  const LLMConnector = getLLMProvider({
    provider: workspace?.chatProvider,
    model: workspace?.chatModel,
  });
  const VectorDb = getVectorDbClass();

  const messageLimit = workspace?.openAiHistory || 20;
  const hasVectorizedSpace = await VectorDb.hasNamespace(workspace.slug);
  const embeddingsCount = await VectorDb.namespaceCount(workspace.slug);

  // User is trying to query-mode chat a workspace that has no data in it - so
  // we should exit early as no information can be found under these conditions.
  if ((!hasVectorizedSpace || embeddingsCount === 0) && chatMode === "query") {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      attachments,
      close: true,
      error: null,
    });
    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }

  // If we are here we know that we are in a workspace that is:
  // 1. Chatting in "chat" mode and may or may _not_ have embeddings
  // 2. Chatting in "query" mode and has at least 1 embedding
  let completeText;
  let metrics = {};
  let contextTexts = [];
  let sources = [];
  let pinnedDocIdentifiers = [];
  const { rawHistory, chatHistory } = await recentChatHistory({
    user,
    workspace,
    thread,
    messageLimit,
  });

  // Look for pinned documents and see if the user decided to use this feature. We will also do a vector search
  // as pinning is a supplemental tool but it should be used with caution since it can easily blow up a context window.
  // However we limit the maximum of appended context to 80% of its overall size, mostly because if it expands beyond this
  // it will undergo prompt compression anyway to make it work. If there is so much pinned that the context here is bigger than
  // what the model can support - it would get compressed anyway and that really is not the point of pinning. It is really best
  // suited for high-context models.
  await new DocumentManager({
    workspace,
    maxTokens: LLMConnector.promptWindowLimit(),
  })
    .pinnedDocs()
    .then((pinnedDocs) => {
      pinnedDocs.forEach((doc) => {
        const { pageContent, ...metadata } = doc;
        pinnedDocIdentifiers.push(sourceIdentifier(doc));
        contextTexts.push(doc.pageContent);
        sources.push({
          text:
            pageContent.slice(0, 1_000) +
            "...continued on in source document...",
          ...metadata,
        });
      });
    });

  const vectorSearchResults =
    embeddingsCount !== 0
      ? await VectorDb.performSimilaritySearch({
          namespace: workspace.slug,
          input: message,
          LLMConnector,
          similarityThreshold: workspace?.similarityThreshold,
          topN: workspace?.topN,
          filterIdentifiers: pinnedDocIdentifiers,
          rerank: workspace?.vectorSearchMode === "rerank",
        })
      : {
          contextTexts: [],
          sources: [],
          message: null,
        };

  // Failed similarity search if it was run at all and failed.
  if (!!vectorSearchResults.message) {
    writeResponseChunk(response, {
      id: uuid,
      type: "abort",
      textResponse: null,
      sources: [],
      close: true,
      error: vectorSearchResults.message,
    });
    return;
  }

  const { fillSourceWindow } = require("../helpers/chat");
  const filledSources = fillSourceWindow({
    nDocs: workspace?.topN || 4,
    searchResults: vectorSearchResults.sources,
    history: rawHistory,
    filterIdentifiers: pinnedDocIdentifiers,
  });

  // Why does contextTexts get all the info, but sources only get current search?
  // This is to give the ability of the LLM to "comprehend" a contextual response without
  // populating the Citations under a response with documents the user "thinks" are irrelevant
  // due to how we manage backfilling of the context to keep chats with the LLM more correct in responses.
  // If a past citation was used to answer the question - that is visible in the history so it logically makes sense
  // and does not appear to the user that a new response used information that is otherwise irrelevant for a given prompt.
  // TLDR; reduces GitHub issues for "LLM citing document that has no answer in it" while keep answers highly accurate.
  contextTexts = [...contextTexts, ...filledSources.contextTexts];
  sources = [...sources, ...vectorSearchResults.sources];

  // If in query mode and no context chunks are found from search, backfill, or pins -  do not
  // let the LLM try to hallucinate a response or use general knowledge and exit early
  if (chatMode === "query" && contextTexts.length === 0) {
    const textResponse =
      workspace?.queryRefusalResponse ??
      "There is no relevant information in this workspace to answer your query.";
    writeResponseChunk(response, {
      id: uuid,
      type: "textResponse",
      textResponse,
      sources: [],
      close: true,
      error: null,
    });

    await WorkspaceChats.new({
      workspaceId: workspace.id,
      prompt: message,
      response: {
        text: textResponse,
        sources: [],
        type: chatMode,
        attachments,
      },
      threadId: thread?.id || null,
      include: false,
      user,
    });
    return;
  }

  // Compress & Assemble message to ensure prompt passes token limit with room for response
  // and build system messages based on inputs and history.

  
  if(workspace.slug=='testing'){
    // override dari sini
    console.log('DRMP HERE')
    console.log(updatedMessage)
    // DISINI, 

    

    // writeResponseChunk(response, {
    //   uuid,
    //   sources,
    //   type: "rechartVisualize",
    //   textResponse: JSON.stringify({
    //     "type": "pie",
    //     "dataset": "[\"name\":\"Asia\", \"value\": 44.57}, {\"name\":\"Africa\", \"value\": 20.61}, {\"name\":\"Eropa\", \"value\": 8.53}, {\"name\":\"Amerika Utara\", \"value\": 6.17}, {\"name\":\"Oseania\", \"value\": 0.28}]",
    //     "title": "Benua Terbesar Dunia",
    //     "caption": "Berikut adalah top 5 benua terbesar dalam bentuk pie chart:\n\n Pie Chart:\n```\n +---------------------------------------+\n | Asia |\n | (44,57%) |\n +---------------------------------------+\n | Afrika |\n | (20,11%) |\n +---------------------------------------+\n | Eropa |\n | (9,71%) |\n +---------------------------------------+\n | Amerika Selatan |\n | (8,10%) |\n +---------------------------------------+\n | Oseania |\n | (2,01%) |\n +---------------------------------------+\n | Australia dan Pasifik |\n | (15,60%) |\n +---------------------------------------+\n```\nTop 5 benua terbesar di dunia berdasarkan luas wilayahnya adalah:\n\n1. Asia (44,57%)\n2. Afrika (20,11%)\n3. Amerika Selatan (8,10%)\n4. Oseania (2,01%)\n5. Australia dan Pasifik (15,60%)"
    //   }),
    //   close:false,
    //   error: false,
    //   metrics,
    // });

    // const { chat } = await WorkspaceChats.new({
    //   workspaceId: workspace.id,
    //   prompt: message,
    //   response: {
    //     text: JSON.stringify({
    //       "type": "pie",
    //       "dataset": "[\"name\":\"Asia\", \"value\": 44.57}, {\"name\":\"Africa\", \"value\": 20.61}, {\"name\":\"Eropa\", \"value\": 8.53}, {\"name\":\"Amerika Utara\", \"value\": 6.17}, {\"name\":\"Oseania\", \"value\": 0.28}]",
    //       "title": "Benua Terbesar Dunia",
    //       "caption": "Berikut adalah top 5 benua terbesar dalam bentuk pie chart:\n\n Pie Chart:\n```\n +---------------------------------------+\n | Asia |\n | (44,57%) |\n +---------------------------------------+\n | Afrika |\n | (20,11%) |\n +---------------------------------------+\n | Eropa |\n | (9,71%) |\n +---------------------------------------+\n | Amerika Selatan |\n | (8,10%) |\n +---------------------------------------+\n | Oseania |\n | (2,01%) |\n +---------------------------------------+\n | Australia dan Pasifik |\n | (15,60%) |\n +---------------------------------------+\n```\nTop 5 benua terbesar di dunia berdasarkan luas wilayahnya adalah:\n\n1. Asia (44,57%)\n2. Afrika (20,11%)\n3. Amerika Selatan (8,10%)\n4. Oseania (2,01%)\n5. Australia dan Pasifik (15,60%)"
    //     }),
    //     sources,
    //     type: 'rechartVisualize',
    //     attachments,
    //     metrics,
    //   },
    //   threadId: thread?.id || null,
    //   user,
    // });

    // writeResponseChunk(response, {
    //   uuid,
    //   type: "finalizeResponseStream",
    //   close: true,
    //   error: false,
    //   metrics,
    // });
    // return;

    console.log(contextTexts)
    console.log(chatHistory)
    console.log(attachments)
    console.log(rawHistory)
      
    // writeResponseChunk(response, {
    //   id: uuidv4(),
    //   type: "abort",
    //   textResponse: null,
    //   sources: [],
    //   close: true,
    //   error: `Error test.`,
    // });
    // return;

    
    const mindsDBHTTP = await getAgent();
    // TEXT2SQL
    let text2sql = '';
    const sqlMessagesHistory = [];
    for (let i = 0; i < chatHistory.length; i += 2) {
      if (chatHistory[i].role === "user" && chatHistory[i + 1]?.role === "assistant") {
        sqlMessagesHistory.push({
          question: chatHistory[i].content,
          answer: chatHistory[i + 1].content
        });
      }
    }
    
    console.log('sqlMessagesHistory')
    console.log(sqlMessagesHistory)
    try{
      const text2sqlGet = await mindsDBHTTP.post(jbconfig.mindsdb_host+'/api/projects/mindsdb/agents/salescube_order_agent/completions',{
        messages: [
          ...sqlMessagesHistory,
          {
            question: updatedMessage,
            answer: null
          }
        ]
      },{
        headers: {
          'Content-Type': 'application/json'
        },
      })

      if(text2sqlGet.data?.message?.content){
        text2sql=text2sqlGet.data?.message?.content;
      }
      
    }catch(err){
      
      console.log('failed fetch text2sql')
      console.log(err.response)
    }
    

    console.log('text2sql')
    console.log(text2sql)

//     CREATE USER salescube_only_user IDENTIFIED WITH sha256_password BY 'testing_password';

// CREATE ROLE salescube_only;
// GRANT SELECT (uuid,item_id,salesmen_name,internal_status,doc_no,ref_no,item_code,item_name,brand_name,item_category_name,channel_type,channel_name,store_name,s_city,s_province,shipper,modal,margin,diskon,ppn,qty,transaction_date,penjualan,company_id) ON analytic.sales_cube TO salescube_only;

// GRANT salescube_only TO salescube_only_user;
    

    // Extract SQL Query Block
    const queryMatch = text2sql.match(/```sql\s*([\s\S]*?)\s*```/);
    let queryResult 
    if (queryMatch) {
      let query = queryMatch[1].trim();

      console.log("\nExtracted SQL Query:");
      console.log(query);

      console.log("\nModified Query:");
      query = updateTableName(query,tableName);
      query = appendWhereClause(query, `company_id='${companyId}'`,tableName);
      console.log(query);

      console.log("\nResult:");
      try{
        const result = await mindsDBHTTP.post(jbconfig.mindsdb_host+'/api/sql/query',{
          "query": query
        },{
          headers: {
            'Content-Type': 'application/json'
          },
        })

        const httpQueryResult = result.data;
        console.log(httpQueryResult)
        if(httpQueryResult?.type=='table'){
          queryResult={
            column_names: httpQueryResult?.column_names,
            data: httpQueryResult?.data
          }
        }else{
          writeResponseChunk(response, {
            id: uuidv4(),
            type: "abort",
            textResponse: null,
            sources: [],
            close: true,
            error: `Error query.`,
          });
          return;
        }
      }catch(err){
        console.log('error get data from query')
        writeResponseChunk(response, {
          id: uuidv4(),
          type: "abort",
          textResponse: null,
          sources: [],
          close: true,
          error: `error get data from query`,
        });
        return;
      }      
    }else{
      writeResponseChunk(response, {
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: `SQL error. Try again later.`,
      });
      return;
    }

    if(!queryResult){
      writeResponseChunk(response, {
        id: uuidv4(),
        type: "abort",
        textResponse: null,
        sources: [],
        close: true,
        error: `SQL error. Try again later.`,
      });
      return;
    }

    console.log('queryResult')
    console.log(queryResult)

    const messages = await LLMConnector.compressMessages(
      {
        systemPrompt: `You are an AI tasked with summarization. I will give you prompt with this format [LANG]xxx;[Question]xxx;[Result]xxx.
        For example if the prompt is:
        [LANG]ID;[Question]How many sales in 2022?;[Result]total_sales 1000000, so the expected output: is "Total penjualan pada tahun 2022 adalah 1.000.000", remember the output is summarization based on your observation.`,
        userPrompt: `[LANG]${language};[Question]${updatedMessage};[Result]${JSON.stringify(queryResult)}`,
        contextTexts,
        chatHistory,
        attachments,
      },
      rawHistory
    );
  
    console.log('DRMP HERE COMPRESS')
    console.log(messages)
  
    // If streaming is not explicitly enabled for connector
    // we do regular waiting of a response and send a single chunk.
    if (LLMConnector.streamingEnabled() !== true) {
      console.log(
        `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
      );
      const { textResponse, metrics: performanceMetrics } =
        await LLMConnector.getChatCompletion(messages, {
          temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        });
  
      completeText = textResponse;
      metrics = performanceMetrics;
      writeResponseChunk(response, {
        uuid,
        sources,
        type: "textResponseChunk",
        textResponse: completeText,
        close: true,
        error: false,
        metrics,
      });
    } else {
      const stream = await LLMConnector.streamGetChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      });
      completeText = await LLMConnector.handleStream(response, stream, {
        uuid,
        sources,
      });
      metrics = stream.metrics;
    }
  
    if (completeText?.length > 0) {
      const { chat } = await WorkspaceChats.new({
        workspaceId: workspace.id,
        prompt: message,
        response: {
          text: completeText,
          sources,
          type: chatMode,
          attachments,
          metrics,
        },
        threadId: thread?.id || null,
        user,
      });
  
      writeResponseChunk(response, {
        uuid,
        type: "finalizeResponseStream",
        close: true,
        error: false,
        chatId: chat.id,
        metrics,
      });
      return;
    }
  
    writeResponseChunk(response, {
      uuid,
      type: "finalizeResponseStream",
      close: true,
      error: false,
      metrics,
    });
    return;
  }else{
    // default
    const messages = await LLMConnector.compressMessages(
      {
        systemPrompt: chatPrompt(workspace),
        userPrompt: updatedMessage,
        contextTexts,
        chatHistory,
        attachments,
      },
      rawHistory
    );
  

  
    // If streaming is not explicitly enabled for connector
    // we do regular waiting of a response and send a single chunk.
    if (LLMConnector.streamingEnabled() !== true) {
      console.log(
        `\x1b[31m[STREAMING DISABLED]\x1b[0m Streaming is not available for ${LLMConnector.constructor.name}. Will use regular chat method.`
      );
      const { textResponse, metrics: performanceMetrics } =
        await LLMConnector.getChatCompletion(messages, {
          temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
        });
  
      completeText = textResponse;
      metrics = performanceMetrics;
      writeResponseChunk(response, {
        uuid,
        sources,
        type: "textResponseChunk",
        textResponse: completeText,
        close: true,
        error: false,
        metrics,
      });
    } else {
      const stream = await LLMConnector.streamGetChatCompletion(messages, {
        temperature: workspace?.openAiTemp ?? LLMConnector.defaultTemp,
      });
      completeText = await LLMConnector.handleStream(response, stream, {
        uuid,
        sources,
      });
      metrics = stream.metrics;
    }
  
    if (completeText?.length > 0) {
      const { chat } = await WorkspaceChats.new({
        workspaceId: workspace.id,
        prompt: message,
        response: {
          text: completeText,
          sources,
          type: chatMode,
          attachments,
          metrics,
        },
        threadId: thread?.id || null,
        user,
      });
  
      writeResponseChunk(response, {
        uuid,
        type: "finalizeResponseStream",
        close: true,
        error: false,
        chatId: chat.id,
        metrics,
      });
      return;
    }
  
    writeResponseChunk(response, {
      uuid,
      type: "finalizeResponseStream",
      close: true,
      error: false,
      metrics,
    });
    return;
  }
  

  
}

module.exports = {
  VALID_CHAT_MODE,
  streamChatWithWorkspace,
};
