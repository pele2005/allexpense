const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const XLSX = require('xlsx');
const Busboy = require('busboy');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ success: false, message: 'Method Not Allowed' }),
    };
  }

  return new Promise((resolve, reject) => {
    const busboy = Busboy({ headers: event.headers });
    const fields = {};
    let fileBuffer = Buffer.from('');
    let fileName = '';

    busboy.on('file', (fieldname, file, filename) => {
      fileName = filename;
      file.on('data', (data) => {
        fileBuffer = Buffer.concat([fileBuffer, data]);
      });
    });

    busboy.on('field', (fieldname, value) => {
      fields[fieldname] = value;
    });

    busboy.on('finish', async () => {
      try {
        if (!fields.username || !fileBuffer.length) {
          return resolve({
            statusCode: 400,
            body: JSON.stringify({ success: false, message: 'Missing user or file' }),
          });
        }

        const workbook = XLSX.read(fileBuffer, { type: 'buffer' });
        const sheet = workbook.Sheets['Data'];
        const jsonData = XLSX.utils.sheet_to_json(sheet);

        const expectedHeaders = [
          'Date','Month','Year','Team','Cost_Center','Type','Account_Group','Account','Hospital','Hospital_Remark',
          'Doctor','Event','Description','Request','Request_Amount','Payby','Payee','Status','Clearing_Date','Clearing_Amount',
          'Plan','Created_By','Created_At','Updated_By','Update_ At','Updated_By_2','Updated_At','Updated_date'
        ];

        const firstRowKeys = Object.keys(jsonData[0] || {});
        const missing = expectedHeaders.filter(h => !firstRowKeys.includes(h));
        if (missing.length > 0) {
          return resolve({
            statusCode: 400,
            body: JSON.stringify({ success: false, message: 'Missing headers: ' + missing.join(', ') })
          });
        }

        const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS_JSON);
        const auth = new JWT({
          email: creds.client_email,
          key: creds.private_key,
          scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        const doc = new GoogleSpreadsheet(process.env.TOTAL_EXPENSE_SHEET_ID, auth);
        await doc.loadInfo();
        const sheetExpense = doc.sheetsByIndex[0];
        const sheetLog = doc.sheetsByTitle['Upload Log'] || await doc.addSheet({
          title: 'Upload Log',
          headerValues: ['Timestamp', 'Username', 'File Name', 'Status', 'Note']
        });

        await sheetExpense.addRows(jsonData);
        await sheetExpense.loadCells('AB2');
        sheetExpense.getCellByA1('AB2').value = new Date().toISOString();
        await sheetExpense.saveUpdatedCells();

        await sheetLog.addRow({
          Timestamp: new Date().toISOString(),
          Username: fields.username,
          'File Name': fileName,
          Status: 'Success',
          Note: `Imported ${jsonData.length} rows`
        });

        return resolve({ statusCode: 200, body: JSON.stringify({ success: true }) });
      } catch (err) {
        console.error('Upload error:', err);

        try {
          const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS_JSON);
          const auth = new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
          });
          const doc = new GoogleSpreadsheet(process.env.TOTAL_EXPENSE_SHEET_ID, auth);
          await doc.loadInfo();
          const sheetLog = doc.sheetsByTitle['Upload Log'] || await doc.addSheet({
            title: 'Upload Log',
            headerValues: ['Timestamp', 'Username', 'File Name', 'Status', 'Note']
          });
          await sheetLog.addRow({
            Timestamp: new Date().toISOString(),
            Username: fields.username || 'Unknown',
            'File Name': fileName,
            Status: 'Failed',
            Note: err.message
          });
        } catch (logErr) {
          console.error('Logging failed:', logErr);
        }

        return resolve({
          statusCode: 500,
          body: JSON.stringify({ success: false, message: err.message }),
        });
      }
    });

    busboy.end(Buffer.from(event.body, 'base64'));
  });
};
