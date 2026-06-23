@echo off
echo ============================================
echo  RIWS - Chimes AI Runway Incursion Warning
echo  Setup Script
echo ============================================
echo.

echo [1/4] Installing root dependencies...
call npm install
if %errorlevel% neq 0 (echo ERROR: Root install failed & pause & exit /b 1)

echo.
echo [2/4] Installing server dependencies...
cd server
call npm install
if %errorlevel% neq 0 (echo ERROR: Server install failed & pause & exit /b 1)
cd ..

echo.
echo [3/4] Installing client dependencies...
cd client
call npm install
if %errorlevel% neq 0 (echo ERROR: Client install failed & pause & exit /b 1)
cd ..

echo.
echo [4/4] Seeding database with demo data...
cd server
call npm run seed
cd ..

echo.
echo ============================================
echo  Setup complete!
echo  Run: npm run dev
echo  Client: http://localhost:5173
echo  Server: http://localhost:3001
echo ============================================
pause
