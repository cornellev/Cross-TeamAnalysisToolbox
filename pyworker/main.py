from fastapi import FastAPI
import subprocess
import os
from cache_api import router as cache_router
from shiny import App as ShinyApp
from shiny_ev import app as shiny_app

app = FastAPI()

@app.get("/")
def root():
    return {"status": "pyworker running"}

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT_PATH = os.path.join(BASE_DIR, "bag_uploader.py")

@app.post("/process/{folder_name}")
def run_process(folder_name: str):
    try:
        result = subprocess.run(
            ["python3", SCRIPT_PATH, folder_name],
            cwd=BASE_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        
        for line in result.stdout.splitlines():
            print(line)

        return {"message": "Processing complete", "output": result.stdout}
    except subprocess.CalledProcessError as e:
        return {"error": e.stderr, "stdout": e.stdout}


# CAT as a derived cache of EVIL's recordings (build / progress / evict): see cache_api.py
app.include_router(cache_router)

app.mount("/ev", shiny_app)
