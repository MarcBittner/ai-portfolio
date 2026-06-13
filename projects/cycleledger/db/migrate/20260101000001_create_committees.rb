# Committees are the recipients of contributions (FEC: the registered political
# committee). Small, slowly-changing dimension table — joined into rollups.
class CreateCommittees < ActiveRecord::Migration[7.2]
  def change
    create_table :committees do |t|
      t.string :fec_id, null: false          # synthetic FEC-style committee id, e.g. "C9000001"
      t.string :name, null: false
      t.string :committee_type, null: false  # "presidential" | "senate" | "house" | "pac"
      t.string :party                         # "DEM" | "REP" | "IND" | nil
      t.timestamps
    end
    add_index :committees, :fec_id, unique: true
  end
end
