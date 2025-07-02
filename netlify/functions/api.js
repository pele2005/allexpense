// ไฟล์นี้จะต้องอยู่ในโฟลเดอร์ netlify/functions/ ภายในโปรเจคของคุณ
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');

// --- ข้อมูลสำคัญที่ต้องตั้งค่าใน Environment Variables ของ Netlify ---
// 1. GOOGLE_SERVICE_ACCOUNT_CREDS_JSON
// 2. TOTAL_EXPENSE_SHEET_ID: 1iQ18yGtavcRAlD0Gu3Igr2qpCuFGT4dl4b32lWBTOdY
// 3. USER_SHEET_ID: 1E-1fKvOG2Yd88RM3WmTAKEzB-Ve1uBuFyDXKGc-ehXY
// 4. PERMISSION_SHEET_ID: 1LXyGjplIU6WZPF-0Ty10aOO_Dl2Kq_lO7EqdhjtZl80

const getServiceAccountAuth = () => {
    try {
        const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_CREDS_JSON);
        return new JWT({
            email: creds.client_email,
            key: creds.private_key,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
    } catch (error) {
        console.error("Failed to parse GOOGLE_SERVICE_ACCOUNT_CREDS_JSON:", error);
        throw new Error("Service Account credentials are not configured correctly.");
    }
};

const parseDate = (dateString) => {
    if (!dateString || typeof dateString !== 'string') return null;
    const parts = dateString.split(/[/.-]/);
    if (parts.length === 3) {
        const day = parseInt(parts[0], 10);
        const month = parseInt(parts[1], 10) - 1;
        let year = parseInt(parts[2], 10);
        if (year < 100) year += 2000;
        if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
            return new Date(Date.UTC(year, month, day));
        }
    }
    return null;
};

const getPermissionsForUser = async (auth, costCenter) => {
    const permDoc = new GoogleSpreadsheet(process.env.PERMISSION_SHEET_ID, auth);
    await permDoc.loadInfo();
    const permSheet = permDoc.sheetsByIndex[0];
    const permRows = await permSheet.getRows();
    const permUserHeader = permSheet.headerValues[0];
    const userPermissionRow = permRows.find(row => String(row.get(permUserHeader) || '').trim() === costCenter);
    let accessibleCostCenters = [costCenter];
    if (userPermissionRow) {
        for (let i = 1; i < permSheet.headerValues.length; i++) {
            const header = permSheet.headerValues[i];
            if (userPermissionRow.get(header)) {
                accessibleCostCenters.push(String(userPermissionRow.get(header)).trim());
            }
        }
    }
    return [...new Set(accessibleCostCenters)];
};

exports.handler = async (event, context) => {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: JSON.stringify({ message: 'Successful preflight call.' }) };
    }

    try {
        const payload = JSON.parse(event.body);
        const action = payload.action;
        const auth = getServiceAccountAuth();

        if (action === 'login') {
            const doc = new GoogleSpreadsheet(process.env.USER_SHEET_ID, auth);
            await doc.loadInfo();
            const sheet = doc.sheetsByIndex[0];
            const rows = await sheet.getRows();
            const userHeader = sheet.headerValues[0];
            const passHeader = sheet.headerValues[1];
            const user = rows.find(row => 
                String(row.get(userHeader) || '').trim().toLowerCase() === String(payload.username).trim().toLowerCase() && 
                String(row.get(passHeader) || '').trim() === String(payload.password).trim()
            );
            if (user) return { statusCode: 200, headers, body: JSON.stringify({ success: true }) };
            return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: 'Cost Center หรือรหัสผ่านไม่ถูกต้อง' }) };
        }

        // === Action ใหม่สำหรับดึงสิทธิ์ ===
        if (action === 'getPermissions') {
            const permissions = await getPermissionsForUser(auth, payload.costCenter);
            return { statusCode: 200, headers, body: JSON.stringify({ success: true, permissions }) };
        }

        if (action === 'getData') {
            const { costCenter, filters } = payload;
            const accessibleCostCenters = await getPermissionsForUser(auth, costCenter);

            const expenseDoc = new GoogleSpreadsheet(process.env.TOTAL_EXPENSE_SHEET_ID, auth);
            await expenseDoc.loadInfo();
            const expenseSheet = expenseDoc.sheetsByIndex[0];
            
            await expenseSheet.loadCells('AB2');
            const updateDateCell = expenseSheet.getCellByA1('AB2');
            const lastUpdate = updateDateCell.formattedValue || 'ไม่ระบุ';
            
            const expenseRows = await expenseSheet.getRows();

            const dateHeader = expenseSheet.headerValues[0]; // Column A
            const typeHeader = expenseSheet.headerValues[5]; // Column F
            const costCenterHeader = expenseSheet.headerValues.find(h => h && h.toLowerCase().replace(/[\s_]/g, '').includes('costcenter'));

            if (!costCenterHeader) throw new Error("Could not find 'Cost Center' header.");

            const startDate = filters.startDate ? parseDate(filters.startDate) : null;
            const endDate = filters.endDate ? parseDate(filters.endDate) : null;

            const filteredData = expenseRows.filter(row => {
                // Filter by selected Cost Center
                const rowCostCenter = String(row.get(costCenterHeader) || '').trim();
                if (filters.selectedCostCenter !== 'all') {
                    if (rowCostCenter !== filters.selectedCostCenter) return false;
                } else {
                    if (!accessibleCostCenters.includes(rowCostCenter)) return false;
                }

                const rowType = String(row.get(typeHeader) || '').trim();
                if (filters.type !== 'all' && rowType !== filters.type) return false;

                const rowDate = parseDate(row.get(dateHeader));
                if (!rowDate) return false;
                if (startDate && rowDate < startDate) return false;
                if (endDate && rowDate > endDate) return false;
                
                return true;
            }).map(row => {
                // === จุดที่แก้ไข: เลือกคอลัมน์ที่จะแสดงผล ===
                const cleanObject = {};
                // ตำแหน่งคอลัมน์ A, E-T, W
                const indicesToShow = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22];
                indicesToShow.forEach(index => {
                    const header = expenseSheet.headerValues[index];
                    if (header) {
                        cleanObject[header] = row.get(header) || '';
                    }
                });
                return cleanObject;
            });

            return { statusCode: 200, headers, body: JSON.stringify({ success: true, data: filteredData, lastUpdate }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Invalid action' }) };

    } catch (error) {
        console.error('API Error:', error);
        return { statusCode: 500, headers, body: JSON.stringify({ success: false, message: 'เกิดข้อผิดพลาดภายใน Server: ' + error.message }) };
    }
};
