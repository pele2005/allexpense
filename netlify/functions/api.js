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

const parseSheetDate = (dateString) => {
    if (!dateString || typeof dateString !== 'string') return null;
    const parts = dateString.split(/[/.-]/);
    if (parts.length === 3) {
        const month = parseInt(parts[0], 10) - 1;
        const day = parseInt(parts[1], 10);
        let year = parseInt(parts[2], 10);
        if (year < 100) year += 2000;
        if (!isNaN(day) && !isNaN(month) && !isNaN(year)) {
            return new Date(Date.UTC(year, month, day));
        }
    }
    return null;
};

const formatNumber = (value) => {
    if (value === null || value === undefined || String(value).trim() === '') return '';
    const num = parseFloat(String(value).replace(/,/g, ''));
    if (isNaN(num)) {
        return value;
    }
    if (Math.abs(num - Math.round(num)) > 0.001) {
        return num.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
        });
    } else {
        return num.toLocaleString('en-US', {
            maximumFractionDigits: 0,
        });
    }
};

// === ฟังก์ชันอ่านสิทธิ์ (Permission) ===
const getPermissionsForUser = async (auth, costCenter) => {
    const permDoc = new GoogleSpreadsheet(process.env.PERMISSION_SHEET_ID, auth);
    await permDoc.loadInfo();
    const permSheet = permDoc.sheetsByIndex[0];
    const permRows = await permSheet.getRows(); // ดึงข้อมูลทุกแถวและคอลัมน์ที่มี
    const permUserHeader = permSheet.headerValues[0];
    const userPermissionRow = permRows.find(row => String(row.get(permUserHeader) || '').trim() === costCenter);
    
    let accessibleCostCenters = [costCenter]; // เพิ่ม Cost Center ของตัวเองเข้าไปก่อนเสมอ
    
    if (userPermissionRow) {
        // วนลูปอ่านทุกคอลัมน์ที่มีหัวข้อ (Header) ตั้งแต่คอลัมน์ที่ 2 (B) เป็นต้นไป
        // โค้ดส่วนนี้จะอ่านคอลัมน์ไปจนถึง AL และไกลกว่านั้นโดยอัตโนมัติ
        for (let i = 1; i < permSheet.headerValues.length; i++) {
            const header = permSheet.headerValues[i];
            if (userPermissionRow.get(header)) { // ถ้าคอลัมน์นั้นมีข้อมูล
                accessibleCostCenters.push(String(userPermissionRow.get(header)).trim());
            }
        }
    }
    // ส่งกลับรายการ Cost Center ที่ไม่ซ้ำกัน
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

            const allHeaders = expenseSheet.headerValues;
            const dateHeader = allHeaders[0]; // Column A
            const typeHeader = allHeaders[5]; // Column F
            const statusHeader = allHeaders[17]; // Column R
            const costCenterHeader = allHeaders.find(h => h && h.toLowerCase().replace(/[\s_]/g, '').includes('costcenter'));
            const requestedHeader = allHeaders[14]; // Column O
            const clearingHeader = allHeaders[19]; // Column T

            if (!costCenterHeader) throw new Error("Could not find 'Cost Center' header.");
            if (!statusHeader) throw new Error("Could not find 'Status' header.");

            const startDate = filters.startDate ? new Date(filters.startDate) : null;
            const endDate = filters.endDate ? new Date(filters.endDate) : null;
            
            let totalRequested = 0;
            let totalClearing = 0;
            
            const pendingStatuses = ["รอแนบใบตอบขอบคุณ", "รอแนบใบเสร็จ"];

            const filteredRows = expenseRows.filter(row => {
                const rowCostCenter = String(row.get(costCenterHeader) || '').trim();
                if (filters.selectedCostCenter !== 'all') {
                    if (rowCostCenter !== filters.selectedCostCenter) return false;
                } else {
                    if (!accessibleCostCenters.includes(rowCostCenter)) return false;
                }

                const rowType = String(row.get(typeHeader) || '').trim();
                if (filters.type !== 'all' && rowType !== filters.type) return false;

                if (filters.status === 'pending') {
                    const rowStatus = String(row.get(statusHeader) || '').trim();
                    if (!pendingStatuses.includes(rowStatus)) {
                        return false;
                    }
                }

                const rowDate = parseSheetDate(row.get(dateHeader));
                if (!rowDate) return false;
                if (startDate && rowDate < startDate) return false;
                if (endDate && rowDate > endDate) return false;
                
                const requestedValue = parseFloat(String(row.get(requestedHeader) || '0').replace(/,/g, ''));
                const clearingValue = parseFloat(String(row.get(clearingHeader) || '0').replace(/,/g, ''));
                if (!isNaN(requestedValue)) totalRequested += requestedValue;
                if (!isNaN(clearingValue)) totalClearing += clearingValue;

                return true;
            });
            
            filteredRows.sort((a, b) => {
                const dateA = parseSheetDate(a.get(dateHeader));
                const dateB = parseSheetDate(b.get(dateHeader));
                if (!dateA) return 1;
                if (!dateB) return -1;
                return dateA - dateB;
            });

            const mappedData = filteredRows.map(row => {
                const cleanObject = {};
                const indicesToShow = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 22];
                indicesToShow.forEach(index => {
                    const header = allHeaders[index];
                    if (header) {
                        let value = row.get(header) || '';
                        
                        if (index === 0 || index === 22) {
                            const dateObj = parseSheetDate(value);
                            if (dateObj) {
                                const day = String(dateObj.getUTCDate()).padStart(2, '0');
                                const month = String(dateObj.getUTCMonth() + 1).padStart(2, '0');
                                const year = dateObj.getUTCFullYear();
                                value = `${day}/${month}/${year}`;
                            }
                        } 
                        else if (index === 14 || index === 19) {
                            value = formatNumber(value);
                        }

                        cleanObject[header.trim()] = value;
                    }
                });
                return cleanObject;
            });

            return { statusCode: 200, headers, body: JSON.stringify({ 
                success: true, 
                data: mappedData, 
                lastUpdate,
                totalRequested,
                totalClearing 
            }) };
        }

        return { statusCode: 400, headers, body: JSON.stringify({ success: false, message: 'Invalid action' }) };

    } catch (error) {
        console.error('API Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ success: false, message: 'เกิดข้อผิดพลาดภายใน Server: ' + error.message })
        };
    }
};
