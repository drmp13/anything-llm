const MindsDB = require("mindsdb-js-sdk").default; // alternative for CommonJS syntax
const axios = require('axios').default
const jbconfig = require('../../config')

// Use 'host' option in MindsDB.connect to specify base URL override
const mindsDBHTTP = axios.create({});

let connected = false

async function getAgent(){
    if(!connected){
        try {
            await MindsDB.connect({
              host: jbconfig.mindsdb_host,
              user: jbconfig.mindsdb_username,
              password: jbconfig.mindsdb_password,
              httpClient: mindsDBHTTP,
              managed: true
            }).then(()=>{
                console.log('MindsDB Connected');
                connected=true
            })
          } catch(error) {
            // Failed to authenticate
            console.log(error);
          }
    }

    return mindsDBHTTP

}

// Utility Functions
function updateTableName(query,tableName) {
    return query
      .replace(/\bclickhouse_analytic\.sales_cube\b/g, 'sales_cube')
      .replace(/\banalytic\.sales_cube\b/g, 'sales_cube')
      .replace(/\bsales_cube\b/g, tableName);
  }

  function appendWhereClause(query, condition,tableName) {
    if (query.includes("WHERE")) {
      return query.replace("WHERE", `WHERE ${condition} AND`);
    } else {
      return query.replace(`FROM ${tableName}`, `FROM ${tableName} WHERE ${condition}`);
    }
  }

module.exports = {getAgent,updateTableName,appendWhereClause}